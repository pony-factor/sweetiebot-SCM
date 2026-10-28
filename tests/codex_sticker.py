import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import codex_sticker
import install


PNG = b"\x89PNG\r\n\x1a\n" + b"test"
JPEG = b"\xff\xd8\xff" + b"test"
GIF = b"GIF89a" + b"test"
WEBP = b"RIFF" + (4).to_bytes(4, "little") + b"WEBP" + b"test"


class StickerCacheTests(unittest.TestCase):
    def test_accepted_formats_private_permissions_and_reset(self):
        for contents, expected in ((PNG, "image/png"), (JPEG, "image/jpeg"),
                                   (GIF, "image/gif"), (WEBP, "image/webp")):
            with self.subTest(mime=expected), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / "private" / "sticker"
                codex_sticker.save_sticker(contents, path)
                self.assertEqual(codex_sticker.load_sticker(path), (expected, contents))
                if os.name == "posix":
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
                codex_sticker.clear_sticker(path)
                self.assertIsNone(codex_sticker.load_sticker(path))

    def test_invalid_or_oversized_upload_does_not_change_existing_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "private" / "sticker"
            codex_sticker.save_sticker(PNG, path)
            for contents in (b"", b"<svg>unsafe</svg>", b"plain text", b"x" * (codex_sticker.MAX_STICKER_BYTES + 1)):
                with self.assertRaises(ValueError):
                    codex_sticker.save_sticker(contents, path)
                self.assertEqual(codex_sticker.load_sticker(path), ("image/png", PNG))

    def test_refuses_symlink_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "actual"
            source.write_bytes(PNG)
            path = Path(temp) / "link"
            path.symlink_to(source)
            with self.assertRaises(ValueError):
                codex_sticker.save_sticker(JPEG, path)
            with self.assertRaises(ValueError):
                codex_sticker.load_sticker(path)
            self.assertEqual(source.read_bytes(), PNG)

    def test_installer_inlines_cached_image_but_not_when_toggle_off(self):
        with patch.object(codex_sticker, "load_sticker", return_value=("image/gif", GIF)):
            enabled = install.codex_rate_limit_script(sticker_enabled=True)
            self.assertIn("data:image/gif;base64,", enabled)
            self.assertIn("const scmToolkitRateLimitStickerEnabled = true;", enabled)
            disabled = install.codex_rate_limit_script(sticker_enabled=False)
            self.assertIn("const scmToolkitRateLimitStickerEnabled = false;", disabled)
            self.assertNotIn("data:image/", disabled)
            self.assertNotIn("__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__", disabled)

    def test_installer_falls_back_to_bundled_image(self):
        with patch.object(codex_sticker, "load_sticker", return_value=None):
            installed = install.codex_rate_limit_script()
        self.assertIn("data:image/png;base64,", installed)


if __name__ == "__main__":
    unittest.main()
