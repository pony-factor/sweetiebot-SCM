from pathlib import Path
import tempfile
import unittest

import codex_composer


class RetiredComposerPatchTests(unittest.TestCase):
    def test_transform_removes_injected_payload(self):
        patched = (
            "base"
            + codex_composer.START
            + "/* edits:[] */\nlegacy injected javascript"
            + codex_composer.END
        )
        self.assertEqual(codex_composer.transform(patched), "base")

    def test_transform_restores_replaced_text(self):
        original = "function demo(){return value??fallback}"
        replacement = 'function demo(){return "Message"??value??fallback}'
        metadata = "/* edits:" + __import__("json").dumps([[original, replacement]]) + " */\n"
        patched = replacement + codex_composer.START + metadata + "legacy" + codex_composer.END
        self.assertEqual(codex_composer.transform(patched), original)

    def test_clean_source_is_unchanged_and_not_selected(self):
        self.assertEqual(codex_composer.transform("clean"), "clean")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "openai.chatgpt-test"
            assets = root / "webview" / "assets"
            assets.mkdir(parents=True)
            (assets / "app-initial-clean.js").write_text("clean")
            self.assertEqual(list(codex_composer.patch_files(root)), [])


if __name__ == "__main__":
    unittest.main()
