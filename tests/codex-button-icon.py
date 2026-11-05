import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

import base64
import os
import tempfile
import unittest
from pathlib import Path

import codex_button_icon
import install

PNG = b"\x89PNG\r\n\x1a\n" + b"test"
JPEG = b"\xff\xd8\xff" + b"test"


class CoauthorIconTests(unittest.TestCase):
    def test_bundle_is_default_and_embedded_in_scm_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            missing = Path(temp) / "missing"
            data_url = codex_button_icon.icon_data_url(destination=missing)
            self.assertTrue(data_url.startswith("data:image/png;base64,"))
            self.assertEqual(base64.b64decode(data_url.partition(",")[2]),
                             codex_button_icon.BUNDLED_ICON.read_bytes())

    def test_custom_image_private_storage_and_reset(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "private" / "coauthor"
            codex_button_icon.save_icon(JPEG, path)
            self.assertEqual(codex_button_icon.load_icon(path), ("image/jpeg", JPEG))
            self.assertEqual(codex_button_icon.icon_data_url(destination=path),
                             "data:image/jpeg;base64," + base64.b64encode(JPEG).decode("ascii"))
            if os.name == "posix":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            for invalid in (b"", b"<svg>script</svg>", b"invalid",
                            b"x" * (codex_button_icon.MAX_ICON_BYTES + 1)):
                with self.assertRaises(ValueError):
                    codex_button_icon.save_icon(invalid, path)
                self.assertEqual(codex_button_icon.load_icon(path), ("image/jpeg", JPEG))
            codex_button_icon.clear_icon(path)
            self.assertIsNone(codex_button_icon.load_icon(path))
            self.assertTrue(codex_button_icon.icon_data_url(destination=path).startswith("data:image/png;base64,"))

    def test_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "image"
            destination.write_bytes(PNG)
            link = Path(temp) / "link"
            link.symlink_to(destination)
            with self.assertRaises(ValueError):
                codex_button_icon.save_icon(JPEG, link)
            with self.assertRaises(ValueError):
                codex_button_icon.load_icon(link)
            self.assertEqual(destination.read_bytes(), PNG)


if __name__ == "__main__":
    unittest.main()
