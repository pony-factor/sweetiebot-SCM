from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import chatgpt_integration


class InstructionSyncTests(unittest.TestCase):
    def test_managed_block_preserves_existing_agents_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "AGENTS.md"
            path.write_text("Existing instructions.\n")

            chatgpt_integration.sync_codex_instructions(
                "Use plain ASCII quotes.",
                True,
                destination=path,
            )

            text = path.read_text()
            self.assertIn("Existing instructions.", text)
            self.assertIn("Use plain ASCII quotes.", text)
            self.assertIn(chatgpt_integration.CODEX_WEB_COAUTHOR, text)
            self.assertEqual(text.count(chatgpt_integration.START), 1)

            chatgpt_integration.sync_codex_instructions(
                "Use concise replies.",
                False,
                destination=path,
            )
            text = path.read_text()
            self.assertIn("Existing instructions.", text)
            self.assertIn("Use concise replies.", text)
            self.assertNotIn(chatgpt_integration.CODEX_WEB_COAUTHOR, text)
            self.assertEqual(text.count(chatgpt_integration.START), 1)

    def test_empty_settings_remove_only_managed_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "AGENTS.md"
            path.write_text(
                "Keep me.\n\n"
                + chatgpt_integration.managed_instruction_block("Temporary", True)
                + "\n"
            )

            chatgpt_integration.sync_codex_instructions("", False, destination=path)

            self.assertEqual(path.read_text(), "Keep me.\n")


class SigningTests(unittest.TestCase):
    @patch("chatgpt_integration.shutil.which")
    @patch("chatgpt_integration.subprocess.run")
    def test_secret_key_is_sent_only_over_stdin(self, run, which):
        which.side_effect = lambda name: f"/usr/bin/{name}"
        run.side_effect = [
            SimpleNamespace(
                returncode=0,
                stdout="sec:-:2048:1:ABC:::::::scESC:::\nfpr:::::::::0123456789ABCDEF0123456789ABCDEF01234567:\n",
                stderr="",
            ),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout="", stderr=""),
        ]

        secret = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecret\n-----END PGP PRIVATE KEY BLOCK-----"
        fingerprint = chatgpt_integration.import_pgp_secret_key(secret)

        self.assertEqual(fingerprint, "0123456789ABCDEF0123456789ABCDEF01234567")
        self.assertEqual(run.call_args_list[0].kwargs["input"], secret)
        self.assertEqual(run.call_args_list[1].kwargs["input"], secret)
        for call in run.call_args_list:
            self.assertNotIn(secret, " ".join(call.args[0]))


if __name__ == "__main__":
    unittest.main()
