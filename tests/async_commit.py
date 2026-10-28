"""Integration checks for provisional local commits and the durable push barrier."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import urllib.error
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
spec = importlib.util.spec_from_file_location("sweetiebot_async_commit", SCRIPTS / "sweetiebot_async_commit.py")
asynchronous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asynchronous)


class AsyncCommitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.previous_cwd = os.getcwd()
        self.previous_env = os.environ.copy()
        os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
        os.environ["GIT_CONFIG_GLOBAL"] = os.devnull
        os.environ["SWEETIEBOT_LOG_FILE"] = str(self.root / "sweetiebot.log")
        os.chdir(self.root)
        self.git_exe = shutil.which("git")
        if self.git_exe is None:
            self.skipTest("Git not installed")
        self.git("init", "-q")
        self.git("config", "user.name", "Sweetiebot Test")
        self.git("config", "user.email", "sweetiebot@example.invalid")

    def tearDown(self):
        os.chdir(self.previous_cwd)
        os.environ.clear()
        os.environ.update(self.previous_env)
        self.tmp.cleanup()

    def git(self, *args, check=True):
        return subprocess.run([self.git_exe, *args], cwd=self.root, text=True,
                              capture_output=True, check=check)

    def prepare(self):
        (self.root / "story.md").write_text("Initial story\n", encoding="utf-8")
        self.git("add", "story.md")
        return asynchronous.begin(
            self.git_exe, [], [], "1 file changed", "+Initial story",
            ["story.md"], False, "Story text",
            str(SCRIPTS / "ai_commit.py"),
            spawn=lambda *_a, **_k: SimpleNamespace(pid=os.getpid()),
        )

    def pending(self):
        folder = Path(self.git("rev-parse", "--absolute-git-dir").stdout.strip())
        return folder / asynchronous.JOURNAL

    def title(self):
        return self.git("log", "-1", "--format=%s").stdout.strip()

    def log_rows(self):
        path = self.root / "sweetiebot.log"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def test_new_job_id_uses_base58_alphabet(self):
        with patch.object(asynchronous.secrets, "choice", return_value="z") as choose:
            self.assertEqual(asynchronous.new_job_id(), "z" * 11)
            self.assertEqual(choose.call_count, 11)
            self.assertTrue(all(call.args == (asynchronous.BASE58_ALPHABET,)
                                for call in choose.call_args_list))

    def test_commit_returns_with_placeholder_then_finalizes_without_restage(self):
        self.assertEqual(self.prepare(), 0)
        job = asynchronous.read_journal(self.pending())
        self.assertTrue(job)
        original = self.git("rev-parse", "HEAD").stdout.strip()
        identities = self.git("log", "-1", "--format=%an|%ae|%at|%cn|%ce|%ct").stdout.strip()
        tree = self.git("rev-parse", "HEAD^{tree}").stdout.strip()
        self.assertIn(asynchronous.PLACEHOLDER, self.title())
        self.assertRegex(job['id'], r'^[1-9A-HJ-NP-Za-km-z]{11}$')
        self.assertEqual(self.title(), 'placeholder_' + job['id'])

        # Work continues while the model works. The worker must not include it.
        (self.root / "story.md").write_text("Subsequent staged story\n", encoding="utf-8")
        self.git("add", "story.md")
        self.assertTrue(asynchronous.finalize(
            self.git_exe, [], job["id"], "✒️ Document the initial story",
            "Record the initial text.",
        ))
        updated = self.git("rev-parse", "HEAD").stdout.strip()
        self.assertNotEqual(updated, original)
        self.assertEqual(self.git("rev-parse", "HEAD^{tree}").stdout.strip(), tree)
        self.assertEqual(self.title(), "✒️ Document the initial story")
        self.assertEqual(self.git("diff", "--cached", "--name-only").stdout.strip(), "story.md")
        self.assertFalse(self.pending().exists())
        self.assertEqual(
            self.git("log", "-1", "--format=%an|%ae|%at|%cn|%ce|%ct").stdout.strip(),
            identities,
        )

    def test_push_gate_blocks_an_in_progress_worker(self):
        self.prepare()
        with self.assertRaisesRegex(RuntimeError, "still pending"):
            asynchronous.wait_for_completion(self.git_exe, [], timeout=0.02)
        self.assertIn(asynchronous.PLACEHOLDER, self.title())

    def test_legacy_worker_does_not_block_a_completed_unrelated_branch(self):
        (self.root / 'base.txt').write_text('Base\n')
        self.git('add', 'base.txt')
        self.git('commit', '-q', '-m', 'Base')
        self.git('branch', 'other')
        self.prepare()
        job = asynchronous.read_journal(self.pending())
        self.git('switch', '-q', 'other')
        asynchronous.wait_for_completion(self.git_exe, [], timeout=0)
        self.assertEqual(asynchronous.read_journal(self.pending())['id'], job['id'])
        self.git('branch', 'inherited', job['sha'])
        with self.assertRaisesRegex(RuntimeError, 'still pending'):
            asynchronous.wait_for_completion(self.git_exe, [], timeout=0, refs=['inherited'])

    def test_crashed_worker_recovers_with_factual_fallback(self):
        self.prepare()
        job = asynchronous.read_journal(self.pending())
        job["pid"] = 99999999
        asynchronous.write_journal(self.pending(), job)
        with patch.object(asynchronous, "fallback", return_value=("💭 Preserve staged content", "")):
            asynchronous.wait_for_completion(self.git_exe, [], timeout=2)
        self.assertEqual(self.title(), "💭 Preserve staged content")
        self.assertFalse(self.pending().exists())
        events = [row["event"] for row in self.log_rows()]
        self.assertIn("async_worker_crashed", events)
        self.assertIn("async_fallback", events)

    def test_worker_attempts_and_fallback_use_the_existing_diagnostics_log(self):
        self.prepare()
        job = asynchronous.read_journal(self.pending())
        import ai_commit
        with patch.object(ai_commit, "emoji_priority_enabled", return_value=False), patch.object(
            ai_commit, "installed_local_model_names", return_value={"local:test"}
        ), patch.object(
            ai_commit, "selected_model", return_value=("local:test", False)
        ), patch.object(
            ai_commit, "ollama_json",
            side_effect=urllib.error.URLError("SECRET MODEL REQUEST RESPONSE")
        ), patch.object(ai_commit.time, "sleep"):
            asynchronous.run_worker(self.git_exe, job["id"], str(self.pending()))
        self.assertFalse(self.pending().exists())
        self.assertNotIn(asynchronous.PLACEHOLDER, self.title())
        rows = self.log_rows()
        failures = [row for row in rows if row["event"] == "request_failed"]
        self.assertEqual([row["attempt"] for row in failures], [1, 2, 3])
        self.assertEqual([row["outcome"] for row in failures],
                         ["retry", "retry", "stopped"])
        self.assertTrue(all(row["component"] == "commit_title" for row in rows))
        # The model helper itself now performs the final simple fallback;
        # it records fallback_used rather than raising to the async worker.
        self.assertEqual(rows[-1]["event"], "fallback_used")
        self.assertEqual(rows[-1]["reason"], "request_failed")
        self.assertNotIn("SECRET", (self.root / "sweetiebot.log").read_text())

    def test_worker_start_failure_is_logged_and_uses_fallback(self):
        (self.root / "story.md").write_text("Story\\n", encoding="utf-8")
        self.git("add", "story.md")

        def fail_spawn(*args, **kwargs):
            raise OSError("SECRET SPAWN FAILURE")

        self.assertEqual(asynchronous.begin(
            self.git_exe, [], [], "1 file", "+Story", ["story.md"], False,
            "Captured change", str(SCRIPTS / "ai_commit.py"), spawn=fail_spawn
        ), 0)
        self.assertFalse(self.pending().exists())
        rows = self.log_rows()
        self.assertEqual([row["event"] for row in rows],
                         ["async_worker_start_failed", "async_fallback"])
        self.assertEqual(rows[0]["error_type"], "OSError")
        self.assertEqual(rows[1]["reason"], "spawn_failed")
        self.assertNotIn("SECRET", (self.root / "sweetiebot.log").read_text())

    def test_failed_async_rewrite_is_logged_and_remains_unpublished(self):
        self.prepare()
        job = asynchronous.read_journal(self.pending())
        (self.root / "later.md").write_text("Later\\n", encoding="utf-8")
        self.git("add", "later.md")
        self.git("commit", "-m", "Another commit")
        import ai_commit
        with patch.object(ai_commit, "generate_message",
                          return_value=("🐞 Fix report title", "")):
            asynchronous.run_worker(self.git_exe, job["id"], str(self.pending()))
        self.assertEqual(self.title(), "Another commit")
        self.assertTrue(self.pending().exists())
        self.assertIn("Branch advanced", asynchronous.read_journal(self.pending())["error"])
        events = self.log_rows()
        self.assertEqual(events[-1]["event"], "async_finalization_failed")
        self.assertEqual(events[-1]["reason"], "commit_rewrite_failed")
        self.assertEqual(events[-1]["outcome"], "blocked")

    def test_changed_head_cannot_be_amended_or_pushed(self):
        self.prepare()
        job = asynchronous.read_journal(self.pending())
        (self.root / "next.md").write_text("Different commit\n", encoding="utf-8")
        self.git("add", "next.md")
        self.git("commit", "-m", "Manual unrelated commit")
        with self.assertRaisesRegex(RuntimeError, "Branch advanced"):
            asynchronous.finalize(self.git_exe, [], job["id"], "🐛 Fix title", "")
        self.assertTrue(self.pending().exists())
        self.assertEqual(self.title(), "Manual unrelated commit")

    def test_crash_between_commit_object_and_ref_update_is_recoverable(self):
        self.prepare()
        job = asynchronous.read_journal(self.pending())
        # Simulate the worker recording the new Git object before CAS succeeds.
        tree = self.git("rev-parse", "HEAD^{tree}").stdout.strip()
        replacement = self.git("commit-tree", tree, "-m", "✒️ Recover title").stdout.strip()
        job["replacement_sha"] = replacement
        asynchronous.write_journal(self.pending(), job)
        asynchronous.wait_for_completion(self.git_exe, [], timeout=1)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), replacement)
        self.assertFalse(self.pending().exists())

    def test_failed_provisional_commit_leaves_no_journal(self):
        code = asynchronous.begin(
            self.git_exe, [], [], "not empty", "not empty", ["missing.md"],
            False, "", str(SCRIPTS / "ai_commit.py"),
            spawn=lambda *_a, **_k: SimpleNamespace(pid=os.getpid()),
        )
        self.assertNotEqual(code, 0)
        self.assertFalse(self.pending().exists())

    def test_refuses_commit_headers_it_cannot_preserve(self):
        raw = (
            "tree " + "a" * 40 + "\n"
            "author A <a@example.invalid> 100 +0000\n"
            "committer A <a@example.invalid> 100 +0000\n"
            "gpgsig -----BEGIN PGP SIGNATURE-----\n\nplaceholder"
        )
        with patch.object(asynchronous, "git_text", return_value=raw):
            with self.assertRaisesRegex(RuntimeError, "signed or extended"):
                asynchronous.commit_metadata(self.git_exe, [], "f" * 40)


if __name__ == "__main__":
    unittest.main()
