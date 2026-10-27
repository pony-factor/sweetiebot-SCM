"""Real bare Git tests for background updates of existing local repositories."""
import fcntl
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import cloud_repo_sync as mirror

class TestRepositorySync(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.remote = self.root / "remote.git"
        self.local = self.root / "local"
        self.git("init", "--bare", "-q", str(self.remote))
        self.git("init", "-b", "main", "-q", str(self.local))
        for key, value in (("user.name", "Tester"), ("user.email", "test@example.invalid")):
            self.git("-C", str(self.local), "config", key, value)
        self.git("-C", str(self.local), "remote", "add", "origin", str(self.remote))
        (self.local / "a.txt").write_text("first\n")
        self.git("-C", str(self.local), "add", "a.txt")
        subprocess.run(["git", "-C", str(self.local), "commit", "-qm", "Initial"],
                       env=dict(os.environ, GIT_AUTHOR_DATE="2020-01-01T00:00:00Z",
                                GIT_COMMITTER_DATE="2020-01-01T00:00:00Z"),
                       check=True, capture_output=True)
        self.git("-C", str(self.local), "push", "-qu", "origin", "main")
    def tearDown(self):
        self.temp.cleanup()
    def git(self, *args):
        subprocess.run(["git", *args], check=True, capture_output=True)
    def ahead_remote(self):
        other = self.root / "other"
        self.git("clone", "-q", "-b", "main", str(self.remote), str(other))
        self.git("-C", str(other), "config", "user.name", "Tester")
        self.git("-C", str(other), "config", "user.email", "test@example.invalid")
        (other / "a.txt").write_text("second\n")
        self.git("-C", str(other), "commit", "-qam", "Second")
        self.git("-C", str(other), "push", "-qu", "origin", "main")
    def test_clean_main_updates_once(self):
        self.ahead_remote()
        self.assertEqual(mirror.update(self.local), "updated")
        self.assertEqual(mirror.update(self.local), "current")
    def test_local_changes_are_preserved(self):
        self.ahead_remote()
        (self.local / "a.txt").write_text("my work\n")
        self.assertEqual(mirror.update(self.local), "local-changes")
        self.assertEqual((self.local / "a.txt").read_text(), "my work\n")
    def test_untracked_and_topic_branch_are_skipped(self):
        (self.local / "b.txt").write_text("untracked\n")
        self.assertEqual(mirror.update(self.local), "local-changes")
        (self.local / "b.txt").unlink()
        self.git("-C", str(self.local), "checkout", "-qb", "topic")
        self.assertEqual(mirror.update(self.local), "other-branch")
    def test_divergence_is_skipped(self):
        self.ahead_remote()
        (self.local / "b.txt").write_text("local\n")
        self.git("-C", str(self.local), "add", "b.txt")
        self.git("-C", str(self.local), "commit", "-qm", "Local")
        self.assertEqual(mirror.update(self.local), "diverged")
    def test_no_upstream_and_symlinked_paths_are_skipped(self):
        self.git("-C", str(self.local), "branch", "--unset-upstream")
        self.assertEqual(mirror.update(self.local), "no-main-upstream")
        link = self.root / "alias"
        link.symlink_to(self.local)
        self.assertEqual(mirror.update(link), "unsafe")

    def test_old_remote_is_inactive_but_new_activity_is_detected(self):
        self.assertEqual(mirror.update(self.local), "inactive")
        self.ahead_remote()
        self.assertEqual(mirror.update(self.local), "updated")

    def test_pending_commit_and_busy_worker_are_skipped(self):
        marker = self.local / ".git" / "sweetiebot-background-commit.json"
        marker.touch()
        self.assertEqual(mirror.update(self.local), "pending-commit")
        marker.unlink()
        with (self.local / ".git" / "sweetiebot-async-commit.lock").open("a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(mirror.update(self.local), "busy")

    def test_fetch_does_not_overwrite_fetch_head(self):
        sentinel = self.local / ".git" / "FETCH_HEAD"
        sentinel.write_text("other operation\n")
        self.ahead_remote()
        self.assertEqual(mirror.update(self.local), "updated")
        self.assertEqual(sentinel.read_text(), "other operation\n")

    def test_branch_switch_during_fetch_is_skipped(self):
        self.ahead_remote()
        original = mirror.git
        def switch(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if args[0] == "fetch":
                self.git("-C", str(path), "checkout", "-qb", "topic")
            return result
        with patch.object(mirror, "git", side_effect=switch):
            self.assertEqual(mirror.update(self.local), "branch-changed")
        self.assertEqual((self.local / "a.txt").read_text(), "first\n")

    def test_discovery_finds_existing_and_remembers_external_folders(self):
        state = self.root / "state"
        registry = state / "repositories.json"
        with patch.object(mirror, "STATE", state), patch.object(mirror, "REGISTRY", registry), \
             patch.object(mirror, "ROOTS", (self.root,)):
            self.assertEqual(list(mirror.discover()), [self.local])
            mirror.register([str(self.local)])
            mirror.register([str(self.local)])
            with patch.object(mirror, "ROOTS", ()):
                self.assertEqual(list(mirror.discover()), [self.local])

    def test_runner_is_enabled_only_explicitly(self):
        with patch.object(mirror, "enabled", return_value=False), \
             patch.object(mirror, "discover") as discover:
            mirror.run()
            discover.assert_not_called()

    def test_install_uses_fifteen_minute_interval_and_launchd_path(self):
        import plistlib
        import subprocess as sp
        agent = self.root / "sync.plist"
        def command(*args, **kwargs):
            return sp.CompletedProcess(args, 1 if args[:2] == ("/bin/launchctl", "print") else 0, "", "")
        with patch.object(mirror, "AGENT", agent), patch.object(mirror, "command", side_effect=command), \
             patch.object(mirror.sys, "platform", "darwin"), patch.object(Path, "home", return_value=self.root):
            mirror.configure(True)
        config = plistlib.loads(agent.read_bytes())
        self.assertEqual(config["StartInterval"], 900)
        self.assertIn("/opt/homebrew/bin", config["EnvironmentVariables"]["PATH"])

    def test_non_origin_upstream_is_used(self):
        self.ahead_remote()
        self.git("-C", str(self.local), "remote", "rename", "origin", "upstream")
        self.assertEqual(mirror.update(self.local), "updated")

    def test_changes_during_fetch_are_preserved(self):
        self.ahead_remote()
        original = mirror.git
        def edit(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if args[0] == "fetch":
                (path / "a.txt").write_text("my work\n")
            return result
        with patch.object(mirror, "git", side_effect=edit):
            self.assertEqual(mirror.update(self.local), "local-changes")
        self.assertEqual((self.local / "a.txt").read_text(), "my work\n")

    def test_pending_commit_in_linked_worktree_is_skipped(self):
        self.git("-C", str(self.local), "checkout", "-qb", "topic")
        worktree = self.root / "worktree"
        self.git("-C", str(self.local), "worktree", "add", "-q", str(worktree), "main")
        meta = subprocess.run(["git", "-C", str(worktree), "rev-parse", "--absolute-git-dir"],
                              capture_output=True, text=True, check=True).stdout.strip()
        (Path(meta) / "sweetiebot-background-commit.json").touch()
        self.assertEqual(mirror.update(worktree), "pending-commit")

    def test_missing_remote_main_is_skipped(self):
        self.git("--git-dir", str(self.remote), "branch", "-m", "main", "retired")
        self.assertEqual(mirror.update(self.local), "no-remote-main")

    def test_unborn_main_is_skipped(self):
        empty = self.root / "empty"
        self.git("init", "-b", "main", "-q", str(empty))
        self.git("-C", str(empty), "remote", "add", "origin", str(self.remote))
        self.git("-C", str(empty), "config", "branch.main.remote", "origin")
        self.git("-C", str(empty), "config", "branch.main.merge", "rextension/heads/main")
        self.assertEqual(mirror.update(empty), "no-main-commit")
