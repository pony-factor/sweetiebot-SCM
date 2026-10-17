"""Real bare Git tests for conservative cloud mirror updates."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import cloud_repo_sync as mirror

class TestCloudMirror(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self.local = self.root / "local"
        self.git("init", "--bare", "-q", str(self.remote))
        self.git("init", "-b", "main", "-q", str(self.local))
        for key, value in (("user.name", "Tester"), ("user.email", "test@example.invalid")):
            self.git("-C", str(self.local), "config", key, value)
        self.git("-C", str(self.local), "remote", "add", "origin", str(self.remote))
        (self.local / "a.txt").write_text("first\n")
        self.git("-C", str(self.local), "add", "a.txt")
        self.git("-C", str(self.local), "commit", "-qm", "Initial")
        self.git("-C", str(self.local), "push", "-q", "origin", "main")
        (self.local / ".git" / "sweetiebot-cloud-mirror").write_text("managed\n")
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
        self.git("-C", str(other), "push", "-q", "origin", "main")
    def test_clean_main_updates_once(self):
        self.ahead_remote()
        self.assertEqual(mirror.update(self.local, str(self.remote)), "updated")
        self.assertEqual(mirror.update(self.local, str(self.remote)), "current")
    def test_local_changes_are_preserved(self):
        self.ahead_remote()
        (self.local / "a.txt").write_text("my work\n")
        self.assertEqual(mirror.update(self.local, str(self.remote)), "local-changes")
        self.assertEqual((self.local / "a.txt").read_text(), "my work\n")
    def test_untracked_and_topic_branch_are_skipped(self):
        (self.local / "b.txt").write_text("untracked\n")
        self.assertEqual(mirror.update(self.local, str(self.remote)), "local-changes")
        (self.local / "b.txt").unlink()
        self.git("-C", str(self.local), "checkout", "-qb", "topic")
        self.assertEqual(mirror.update(self.local, str(self.remote)), "other-branch")
    def test_divergence_is_skipped(self):
        self.ahead_remote()
        (self.local / "b.txt").write_text("local\n")
        self.git("-C", str(self.local), "add", "b.txt")
        self.git("-C", str(self.local), "commit", "-qm", "Local")
        self.assertEqual(mirror.update(self.local, str(self.remote)), "diverged")
    def test_foreign_and_symlinked_paths_are_skipped(self):
        (self.local / ".git" / "sweetiebot-cloud-mirror").unlink()
        self.assertEqual(mirror.update(self.local, str(self.remote)), "unmanaged")
        link = self.root / "alias"
        link.symlink_to(self.local)
        self.assertEqual(mirror.update(link, str(self.remote)), "unsafe")
    def test_discovery_excludes_non_main_and_archived(self):
        class Response:
            stdout = json.dumps([[{"full_name":"ok/repo","default_branch":"main"},
              {"full_name":"ok/other","default_branch":"master"},
              {"full_name":"ok/old","default_branch":"main","archived":True}]])
        with patch.object(mirror, "command", return_value=Response()):
            self.assertEqual(list(mirror.discover()), [["ok", "repo"]])
