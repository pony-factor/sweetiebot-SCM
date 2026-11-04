"""Private, local customization for the SCM Codex co-author button icon.

The bundled Sweetiebot image is the default. User uploads never enter Git
configuration, VS Code settings sync, or the repository.
"""

from __future__ import annotations

import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / "importaliases.py").is_file()
                   else _sb_parent / "scripts")
    if (_sb_scripts / "importaliases.py").is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

import base64
from pathlib import Path

import codex_sticker


SOURCE_ICON = Path(__file__).resolve().parent.parent / "assets" / "imgs" / "sweetiebot.png"
PACKAGED_ICON = Path(__file__).resolve().parent / "codex-customizations" / "assets" / "imgs" / "sweetiebot.png"
BUNDLED_ICON = SOURCE_ICON if SOURCE_ICON.is_file() else PACKAGED_ICON
MAX_ICON_BYTES = codex_sticker.MAX_STICKER_BYTES


def icon_path() -> Path:
    return codex_sticker.sticker_path().with_name("codex-coauthor-button-icon")


def save_icon(data: bytes, destination: Path | None = None) -> Path:
    return codex_sticker.save_sticker(data, destination or icon_path())


def load_icon(destination: Path | None = None) -> tuple[str, bytes] | None:
    return codex_sticker.load_sticker(destination or icon_path())


def clear_icon(destination: Path | None = None) -> None:
    codex_sticker.clear_sticker(destination or icon_path())


def icon_data_url(destination: Path | None = None, bundled_path: Path | None = None) -> str:
    custom = load_icon(destination)
    if custom is None:
        data = (bundled_path or BUNDLED_ICON).read_bytes()
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Bundled Sweetiebot co-author icon must be a PNG.")
        mime = "image/png"
    else:
        mime, data = custom
    return "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")
