import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import local_setup


class InstructionFileTests(unittest.TestCase):
    def test_saves_standalone_instructions_without_git_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "commit-instructions.md"
            with patch.object(local_setup, "commit_instructions_path", return_value=path):
                local_setup.save_commit_instructions("Prefer concise subjects.")

                self.assertEqual(path.read_text(), "Prefer concise subjects.\n")
                self.assertEqual(local_setup.load_commit_instructions(), "Prefer concise subjects.\n")

    def test_refuses_to_replace_symlinked_instruction_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "target.md"
            target.write_text("keep")
            path = root / "commit-instructions.md"
            path.symlink_to(target)
            with patch.object(local_setup, "commit_instructions_path", return_value=path):
                with self.assertRaisesRegex(RuntimeError, "symlinked"):
                    local_setup.save_commit_instructions("replace")


class SigningKeyTests(unittest.TestCase):
    @patch.object(local_setup.shutil, "which", return_value="/usr/bin/git")
    @patch.object(local_setup.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="Test User", stderr=""))
    def test_git_identity_lookup_uses_stable_directory(self, run, _which):
        self.assertEqual(local_setup._git_value("user.name"), "Test User")
        self.assertEqual(run.call_args.kwargs["cwd"], Path.home())

    def test_configures_git_with_fingerprint_only(self):
        fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567"
        with patch.object(local_setup, "list_signing_keys", return_value=[{"fingerprint": fingerprint, "uid": "Test"}]), \
             patch.object(local_setup.shutil, "which", side_effect=lambda name: "/usr/bin/git" if name == "git" else "/usr/bin/gpg"), \
             patch.object(local_setup.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
            result = local_setup.configure_signing_key(fingerprint)

        self.assertEqual(result, fingerprint)
        self.assertEqual(run.call_count, 3)
        for call in run.call_args_list:
            self.assertEqual(call.kwargs.get("cwd"), Path.home())
            self.assertNotIn("input", call.kwargs)
            self.assertNotIn("PRIVATE KEY", " ".join(call.args[0]))
        self.assertIn(fingerprint, run.call_args_list[0].args[0])

    def test_generation_uses_gpg_pinentry_flow_without_secret_payload(self):
        fingerprint = "89ABCDEF0123456789ABCDEF0123456789ABCDEF"
        key_lists = [
            [],
            [{"fingerprint": fingerprint, "uid": "Example User <user@example.com>"}],
        ]

        def git_value(key):
            return {"user.name": "Example User", "user.email": "user@example.com"}.get(key, "")

        with patch.object(local_setup, "_git_value", side_effect=git_value), \
             patch.object(local_setup, "list_signing_keys", side_effect=key_lists), \
             patch.object(local_setup, "configure_signing_key", return_value=fingerprint) as configure, \
             patch.object(local_setup.shutil, "which", return_value="/usr/bin/gpg"), \
             patch.object(local_setup.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
            result = local_setup.generate_signing_key()

        self.assertEqual(result, fingerprint)
        command = run.call_args.args[0]
        self.assertIn("--quick-generate-key", command)
        self.assertIn("Example User <user@example.com>", command)
        self.assertNotIn("input", run.call_args.kwargs)
        configure.assert_called_once_with(fingerprint)


if __name__ == "__main__":
    unittest.main()
