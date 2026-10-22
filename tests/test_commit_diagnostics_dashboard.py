"""Regression tests for the local settings commit diagnostics dashboard."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

import commit_diagnostics_dashboard as dashboard
import configurator
import toolkit_settings
import workspace_search


class DiagnosticsSnapshotTests(unittest.TestCase):
    def test_aggregates_only_active_jobs_and_sanitized_events(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            home, gitdir = root / "jobs", root / "repository" / ".git"
            gitdir.mkdir(parents=True)
            active = home / "abcdef123456"
            active.mkdir(parents=True)
            stale = home / "stale"
            stale.mkdir()
            current = {
                "id": "abcdef123456", "root": "/private/example-repo",
                "branch": "refs/heads/feature/report", "gitdir": str(gitdir),
                "phase": "generating", "message": "SECRET GENERATED TITLE",
                "context": "SECRET CHAT", "diff": "SECRET DIFF",
            }
            (active / "job.json").write_text(json.dumps(current))
            (stale / "job.json").write_text(json.dumps({
                **current, "id": "stale", "phase": "blocked",
            }))
            (gitdir / dashboard.MARKER).write_text(json.dumps({
                "id": "abcdef123456",
                "jobs": [{"id": "abcdef123456", "directory": str(active)}],
            }))
            logfile = root / "sweetiebot.log"
            logfile.write_text("\n".join(json.dumps(event) for event in [
                {"timestamp": "2026-10-22T01:00:00+00:00", "component": "commit_title",
                 "event": "output_rejected", "reason": "filename_only",
                 "outcome": "retry", "prompt": "SECRET PROMPT"},
                {"timestamp": "2026-10-22T01:01:00+00:00", "component": "commit_title",
                 "event": "generation_completed", "duration_ms": 1200,
                 "outcome": "success", "title": "🖌️ Show final titles",
                 "rule": "priority",
                 "explanation": "This wording reflects the added title history.",
                 "response": "SECRET RESPONSE", "description": "SECRET DESCRIPTION"},
                {"timestamp": "2026-10-22T01:02:00+00:00", "component": "commit_title",
                 "event": "generation_completed", "duration_ms": 2800},
                {"timestamp": "2026-10-22T01:03:00+00:00", "component": "commit_title",
                 "event": "fallback_used", "reason": "request_failed"},
            ]))
            with patch.dict(os.environ, {
                "SWEETIEBOT_COMMIT_JOBS": str(home),
                "SWEETIEBOT_LOG_FILE": str(logfile),
            }):
                result = dashboard.read_diagnostics()
            self.assertEqual(len(result["jobs"]), 1)
            self.assertEqual(result["jobs"][0]["repository"], "example-repo")
            self.assertEqual(result["jobs"][0]["branch"], "feature/report")
            self.assertEqual(result["summary"]["pending"], 1)
            self.assertEqual(result["summary"]["generating"], 1)
            self.assertEqual(result["summary"]["blocked"], 0)
            self.assertEqual(result["summary"]["retries"], 1)
            self.assertEqual(result["summary"]["fallbacks"], 1)
            self.assertEqual(result["summary"]["averageGenerationMs"], 2000)
            self.assertEqual(result["summary"]["generated"], 2)
            self.assertEqual(next(e["title"] for e in result["events"] if "title" in e),
                             "🖌️ Show final titles")
            self.assertEqual(next(e["explanation"] for e in result["events"] if "explanation" in e),
                             "This wording reflects the added title history.")
            self.assertEqual(next(e["rule"] for e in result["events"] if "rule" in e), "priority")
            snapshot = json.dumps(result)
            for secret in ("SECRET PROMPT", "SECRET DIFF", "SECRET CHAT",
                           "SECRET RESPONSE", "SECRET DESCRIPTION",
                           "SECRET GENERATED TITLE"):
                self.assertNotIn(secret, snapshot)

    def test_successful_title_logs_without_commit_body(self):
        from sweetiebot_diagnostics import log_event

        with tempfile.TemporaryDirectory() as temp:
            logfile = Path(temp) / "sweetiebot.log"
            with patch.dict(os.environ, {
                "SWEETIEBOT_LOG_FILE": str(logfile),
                "SWEETIEBOT_COMMIT_JOBS": str(Path(temp) / "jobs"),
            }):
                self.assertTrue(log_event(
                    "commit_title", "generation_completed",
                    title="🖌️ Show final titles", duration_ms=1850,
                    rule="change_type", explanation="The change improves history display.",
                    model="local", description="PRIVATE COMMIT BODY",
                    prompt="PRIVATE PROMPT", diff="PRIVATE DIFF",
                ))
                result = dashboard.read_diagnostics()
            self.assertEqual(result["events"][0]["title"], "🖌️ Show final titles")
            self.assertEqual(result["events"][0]["duration_ms"], 1850)
            self.assertEqual(result["events"][0]["rule"], "change_type")
            self.assertEqual(result["events"][0]["explanation"], "The change improves history display.")
            self.assertEqual(result["summary"]["averageGenerationMs"], 1850)
            self.assertNotIn("PRIVATE", json.dumps(result))
            self.assertNotIn("PRIVATE", logfile.read_text(encoding="utf-8"))

    def test_missing_and_malformed_files_do_not_break_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            home = root / "jobs"
            home.mkdir()
            bad = home / "bad"
            bad.mkdir()
            (bad / "job.json").write_text("{bad json")
            log = root / "logs"
            log.write_text("not json\n{}")
            with patch.dict(os.environ, {
                "SWEETIEBOT_COMMIT_JOBS": str(home),
                "SWEETIEBOT_LOG_FILE": str(log),
            }):
                result = dashboard.read_diagnostics()
            self.assertEqual(result["jobs"], [])
            self.assertEqual(result["events"], [])
            self.assertIsNone(result["summary"]["averageGenerationMs"])

    def test_settings_tab_and_installer_include_diagnostics(self):
        page = configurator.render_form(
            toolkit_settings.DEFAULT_SETTINGS, [], "Ollama offline", "token", "Save"
        )
        self.assertIn('id="diagnostics-dashboard"', page)
        self.assertIn('>Diagnostics</button>', page)
        self.assertIn("'/diagnostics' + location.search", page)
        self.assertIn("diag-duration", page)
        self.assertIn("<th>Final title</th>", page)
        self.assertIn("event.title ||", page)
        self.assertIn("Why this title?", page)
        self.assertIn("AI explanation:", page)
        self.assertIn("diagnostics-auto-refresh", page)
        self.assertIn("diagnostics-export", page)
        self.assertIn(Path("commit_diagnostics_dashboard.py"), workspace_search.source_files())


class DiagnosticsServerTests(unittest.TestCase):
    @patch("configurator.fetch_ollama_models", return_value=([], "Ollama offline"))
    def test_diagnostics_api_requires_token(self, _models):
        ready = threading.Event()
        captured = {}

        def open_browser(url):
            captured["url"] = url
            ready.set()
            return True

        with patch("configurator.webbrowser.open", side_effect=open_browser), \
             patch("configurator.print"), \
             patch("configurator.read_diagnostics", return_value={
                 "jobs": [], "events": [], "summary": {"pending": 0},
             }) as collect:
            thread = threading.Thread(
                target=configurator.run_configurator,
                args=(toolkit_settings.DEFAULT_SETTINGS,), daemon=True,
            )
            thread.start()
            self.assertTrue(ready.wait(5))
            parts = urllib.parse.urlsplit(captured["url"])

            def url(path, authorized=True):
                return urllib.parse.urlunsplit((
                    parts.scheme, parts.netloc, path, parts.query if authorized else "", "",
                ))
            try:
                with urllib.request.urlopen(url("/diagnostics"), timeout=5) as response:
                    self.assertEqual(json.load(response)["summary"]["pending"], 0)
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
                collect.assert_called_once()
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    urllib.request.urlopen(url("/diagnostics", authorized=False), timeout=5)
                self.assertEqual(denied.exception.code, 404)
                denied.exception.close()
            finally:
                request = urllib.request.Request(
                    url("/save"), data=b"action=cancel", method="POST")
                urllib.request.urlopen(request, timeout=5).close()
                thread.join(5)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
