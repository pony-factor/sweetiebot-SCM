import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import codex_composer


class RetiredComposerPatchTests(unittest.TestCase):
    def test_inline_location_is_reversible_and_preserves_native_source(self):
        source = '/* composer.placeholder.localFollowUp.locally */\nbase;'
        patched = codex_composer.transform_layout(source)
        self.assertTrue(patched.startswith(source))
        self.assertIn(codex_composer.LAYOUT_START + ';\n', patched)
        self.assertEqual(codex_composer.transform_layout(patched), patched)
        self.assertEqual(codex_composer.transform_layout(patched, False), source)
        self.assertEqual(codex_composer.transform(patched), patched)


    def test_clipboard_button_patch_is_reversible_and_independent_of_location(self):
        source = '/* composer.placeholder.localFollowUp.locally */\nbase;'
        patched = codex_composer.transform_layout(source, inline=False, paste_button=True)
        self.assertIn(codex_composer.PASTE_START, patched)
        self.assertNotIn(codex_composer.LAYOUT_START, patched)
        self.assertIn('scm-toolkit-codex-clipboard-submit', patched)
        self.assertEqual(codex_composer.transform_layout(patched, False, True), patched)
        self.assertEqual(codex_composer.transform_layout(patched, False, False), source)

    def test_clipboard_patch_refuses_partial_marker(self):
        source = 'base' + codex_composer.PASTE_START + 'incomplete'
        with self.assertRaisesRegex(ValueError, 'clipboard'):
            codex_composer.transform_layout(source, False, True)

    def test_transform_removes_injected_payload(self):
        patched = (
            "base"
            + codex_composer.START
            + "/* edits:[] */\nlegacy injected javascript"
            + codex_composer.END
        )
        self.assertEqual(codex_composer.transform(patched), "base")

    def test_transform_restores_exact_pr_93_metadata_format(self):
        original = "function demo(){return value??fallback}"
        replacement = 'function demo(){return "Message"??value??fallback}'
        metadata = "/* edits:" + json.dumps([[original, replacement]]) + " */\n"
        patched = replacement + codex_composer.START + metadata + "legacy" + codex_composer.END

        self.assertEqual(codex_composer.transform(patched), original)

    def test_repair_writes_only_previously_patched_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "openai.chatgpt-test"
            assets = root / "webview" / "assets"
            assets.mkdir(parents=True)
            clean = assets / "app-initial-clean.js"
            clean.write_text("clean")
            patched = assets / "app-initial-patched.js"
            patched.write_text(
                "base"
                + codex_composer.START
                + "/* edits:[] */\nlegacy"
                + codex_composer.END
            )

            repaired = codex_composer.repair(root)

            self.assertEqual(repaired, [patched])
            self.assertEqual(clean.read_text(), "clean")
            self.assertEqual(patched.read_text(), "base")

    def test_repair_validates_all_bundles_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "openai.chatgpt-test"
            assets = root / "webview" / "assets"
            assets.mkdir(parents=True)
            first = assets / "app-initial-a.js"
            first.write_text(
                "first"
                + codex_composer.START
                + "/* edits:[] */\nlegacy"
                + codex_composer.END
            )
            broken = assets / "app-initial-b.js"
            broken.write_text(
                "second"
                + codex_composer.START
                + "missing metadata"
                + codex_composer.END
            )

            with self.assertRaisesRegex(ValueError, "missing edit metadata"):
                codex_composer.repair(root)

            self.assertIn(codex_composer.START, first.read_text())

    def test_clean_source_is_unchanged_and_not_selected(self):
        self.assertEqual(codex_composer.transform("clean"), "clean")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "openai.chatgpt-test"
            assets = root / "webview" / "assets"
            assets.mkdir(parents=True)
            (assets / "app-initial-clean.js").write_text("clean")
            self.assertEqual(list(codex_composer.patch_files(root)), [])

    def test_repair_restores_partial_failed_write_and_previous_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = root / "webview" / "assets"
            assets.mkdir(parents=True)
            original = "base" + codex_composer.START + "/* edits:[] */\nlegacy" + codex_composer.END
            first = assets / "app-initial-a.js"
            second = assets / "app-initial-b.js"
            first.write_text(original)
            second.write_text(original)
            write_text = Path.write_text
            failed = False

            def fail_once(path, content, *args, **kwargs):
                nonlocal failed
                if path == second and not failed:
                    failed = True
                    write_text(path, "partial")
                    raise OSError("interrupted write")
                return write_text(path, content, *args, **kwargs)

            with patch.object(Path, "write_text", fail_once):
                with self.assertRaisesRegex(OSError, "interrupted write"):
                    codex_composer.repair(root)
            self.assertEqual(first.read_text(), original)
            self.assertEqual(second.read_text(), original)


if __name__ == "__main__":
    unittest.main()
