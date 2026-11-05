"""Private, user-local storage for the Codex rate-limit sticker.

Never write uploaded artwork into a repository, Git config, or extension settings.
Only an opt-in local installer embeds the bytes into the Codex webview.
"""

from __future__ import annotations

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


import os
import sys
import tempfile
from pathlib import Path

MAX_STICKER_BYTES = 2 * 1024 * 1024


def sticker_path() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "Sweetiebot"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "sweetiebot"
    return base / "private" / "codex-rate-limit-sticker"


def sticker_mime(data: bytes) -> str:
    if not data or len(data) > MAX_STICKER_BYTES:
        raise ValueError("Image must be nonempty and no larger than 2 MB.")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise ValueError("Choose a PNG, JPEG, GIF, or WebP image (SVG is not supported).")


def save_sticker(data: bytes, destination: Path | None = None) -> Path:
    sticker_mime(data)
    path = destination or sticker_path()
    parent = path.parent
    if parent.is_symlink():
        raise ValueError("Private image directory must not be a symbolic link.")
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(parent, 0o700)
    if path.is_symlink():
        raise ValueError("Private image file must not be a symbolic link.")
    fd, temp = tempfile.mkstemp(prefix=".sticker-", dir=parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return path


def load_sticker(destination: Path | None = None) -> tuple[str, bytes] | None:
    path = destination or sticker_path()
    if path.is_symlink():
        raise ValueError("Private image file must not be a symbolic link.")
    if not path.is_file():
        return None
    if path.stat().st_size > MAX_STICKER_BYTES:
        raise ValueError("Cached sticker exceeds the 2 MB limit.")
    with path.open("rb") as stream:
        data = stream.read(MAX_STICKER_BYTES + 1)
    return sticker_mime(data), data


def clear_sticker(destination: Path | None = None) -> None:
    path = destination or sticker_path()
    if path.is_symlink():
        raise ValueError("Private image file must not be a symbolic link.")
    path.unlink(missing_ok=True)
