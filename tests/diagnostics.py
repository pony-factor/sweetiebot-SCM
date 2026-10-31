import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import sweetiebot_diagnostics as diagnostics


class DiagnosticsTests(unittest.TestCase):
    def test_writes_structured_private_log_with_only_allowlisted_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            location = Path(temp) / "nested" / "sweetiebot.log"
            with patch.dict(os.environ, {"SWEETIEBOT_LOG_FILE": str(location)}):
                self.assertTrue(diagnostics.log_event(
                    "commit_title", "output_rejected", model="local",
                    attempt=1, attempts=3, reason="filename_only", outcome="retry",
                    prompt="PRIVATE DIFF", response="PRIVATE CHAT", error="secret",
                ))
            row = json.loads(location.read_text(encoding="utf-8").strip())
            self.assertEqual(row["component"], "commit_title")
            self.assertEqual(row["reason"], "filename_only")
            self.assertEqual(row["attempt"], 1)
            self.assertIn("timestamp", row)
            self.assertNotIn("PRIVATE", location.read_text(encoding="utf-8"))
            self.assertEqual(stat.S_IMODE(location.stat().st_mode), 0o600)

    def test_correlates_events_to_checkout_and_durable_job_without_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            checkout = root / "flawless-GPT"
            nested = checkout / "src" / "core"
            nested.mkdir(parents=True)
            (checkout / ".git").write_text("gitdir: /private/worktree/metadata\\n")
            logfile = root / "events.log"
            with patch.dict(os.environ, {
                "SWEETIEBOT_LOG_FILE": str(logfile),
                "SWEETIEBOT_BACKGROUND_JOB": "7Aq9rE3Dp6P",
            }), patch.object(diagnostics.Path, "cwd", return_value=nested):
                self.assertTrue(diagnostics.log_event(
                    "commit_title", "generation_completed", title="🖌️ Finish title",
                    prompt="PRIVATE PROMPT", diff="PRIVATE DIFF", description="PRIVATE BODY"))
            event = json.loads(logfile.read_text())
            self.assertEqual(event["repository"], "flawless-GPT")
            self.assertEqual(event["job_id"], "7Aq9rE3Dp6P")
            self.assertNotIn(str(root), logfile.read_text())
            self.assertNotIn("PRIVATE", logfile.read_text())

    def test_invalid_job_ids_and_non_repositories_are_not_logged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            logfile = root / "events.log"
            with patch.dict(os.environ, {
                "SWEETIEBOT_LOG_FILE": str(logfile),
                "SWEETIEBOT_BACKGROUND_JOB": "../../private/job.json",
            }), patch.object(diagnostics.Path, "cwd", return_value=root):
                self.assertTrue(diagnostics.log_event(
                    "commit_title", "request_failed", repository="../private",
                    job_id="../../other-job"))
            event = json.loads(logfile.read_text())
            self.assertNotIn("repository", event)
            self.assertNotIn("job_id", event)

    def test_rotates_and_bounds_log_size(self):
        with tempfile.TemporaryDirectory() as temp:
            location = Path(temp) / "sweetiebot.log"
            with patch.dict(os.environ, {"SWEETIEBOT_LOG_FILE": str(location)}), patch.object(
                diagnostics, "MAX_LOG_BYTES", 500
            ):
                for index in range(20):
                    self.assertTrue(diagnostics.log_event(
                        "commit_title", "output_rejected", model="local",
                        attempt=index, reason="invalid_message",
                    ))
            self.assertTrue(location.with_name("sweetiebot.log.1").exists())
            self.assertLessEqual(location.stat().st_size, 500)
            self.assertFalse(location.with_name("sweetiebot.log.4").exists())

    def test_bad_log_path_does_not_fail_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            blocking_file = Path(temp) / "file"
            blocking_file.write_text("original")
            with patch.dict(os.environ, {
                "SWEETIEBOT_LOG_FILE": str(blocking_file / "cannot-create.log")
            }):
                self.assertFalse(diagnostics.log_event("commit_title", "failed"))
            self.assertEqual(blocking_file.read_text(), "original")

    def test_rejects_symlinked_log(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "private"
            destination.write_text("unchanged")
            log = Path(temp) / "sweetiebot.log"
            log.symlink_to(destination)
            with patch.dict(os.environ, {"SWEETIEBOT_LOG_FILE": str(log)}):
                self.assertFalse(diagnostics.log_event("commit_title", "failed"))
            self.assertEqual(destination.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
