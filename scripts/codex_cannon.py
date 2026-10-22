"""Safely adapt a pinned Flawless-GPT cannon to the native Codex webview.

No Flawless logic or artwork is hand-vendored: pin, fetch, hash-check and adapt.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from urllib.request import urlopen

REVISION = "bb98089c648709ea18ceae6b6c6dad843bd93a57"
BASE_URL = "https://raw.githubusercontent.com/pony-factor/flawless-GPT"
UPSTREAM = {
    "js/chat/worked-duration.js": "4dbeb8d18801c59f324d7b104febce1371fadf6d",
    "css/worked-duration.css": "da388c79f5a609e66b0da697bd758d50a1975b97",
    "artwork/searching-complete.png": "b7bf1916281b12feb9e0557fbf8b879a66833ba2",
}


def git_blob_matches(data: bytes, sha: str) -> bool:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest() == sha


def read_resource(path: str, source_dir: Path | None, cache_dir: Path) -> bytes:
    expected = UPSTREAM[path]
    if source_dir is not None:
        content = (source_dir / path).read_bytes()
        if not git_blob_matches(content, expected):
            raise ValueError(f"Local Flawless-GPT source does not match pinned revision: {path}")
        return content

    cache_file = cache_dir / path
    if cache_file.is_file():
        content = cache_file.read_bytes()
        if git_blob_matches(content, expected):
            return content

    with urlopen(f"{BASE_URL}/{REVISION}/{path}", timeout=12) as response:
        content = response.read(2_000_001)
    if len(content) > 2_000_000 or not git_blob_matches(content, expected):
        raise ValueError(f"Unverified Flawless-GPT download: {path}")
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_bytes(content)
    return content


def replace_once(source: str, original: str, replacement: str) -> str:
    if source.count(original) != 1:
        raise ValueError("Unexpected pinned Flawless-GPT script shape")
    return source.replace(original, replacement, 1)


def adapt(script: str, css: str, png: bytes) -> str:
    """Reuse the upstream parser, mutation observer, display and native markup."""
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Flawless cannon artwork must be a PNG")

    data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    script = replace_once(
        script, "const context = globalThis.__ghrcExtensionContext;",
        "const context = { active: () => true, onStop: () => {} };",
    )

    # A data URL works in Codex's isolated webview and remains available offline.
    image_line = next((line for line in script.splitlines()
                       if "const artworkURL =" in line), None)
    if image_line is None or "chrome.runtime.getURL" not in image_line:
        raise ValueError("Flawless cannon URL anchor is missing")
    script = replace_once(script, image_line,
        '  const artworkURL = "url(" + JSON.stringify(' + json.dumps(data_url) + ') + ")";')
    script = replace_once(
        script,
        r"const PREFIX = /^Worked\s+for\s+(.+)$/i;",
        r"const PREFIX = /^(?:Working|Worked|Thought)\s+for\s+(.+)$/i;",
    )
    script = replace_once(
        script, 'const root = document.querySelector("main");',
        'const root = document.querySelector("main") || document.body;',
    )

    start = script.find("  const onSettingsChanged = (changes, areaName) => {")
    end = script.find("  const observer = new MutationObserver(scheduleScan);")
    if start < 0 or end <= start or script.count("  const observer = new MutationObserver(scheduleScan);") != 1:
        raise ValueError("Flawless Chrome storage adapter cannot be isolated")
    script = script[:start] + "  // Sweetiebot owns the install-time cannon preference.\n" + script[end:]

    # The native text is never replaced, leaving precise timing accessible.
    style = (
        "(() => { const id = 'scm-toolkit-flawless-cannon-style';"
        "if (document.getElementById(id)) return;"
        "const element = document.createElement('style'); element.id = id;"
        "element.textContent = " + json.dumps(css) + ";"
        "(document.head || document.documentElement).appendChild(element); })();"
    )
    return "globalThis.scmToolkitShowCannon = true;\n" + style + "\n" + script


def bundle(source_dir: Path | None = None, cache_root: Path | None = None) -> str:
    if source_dir is None and os.environ.get("SCM_TOOLKIT_FLAWLESS_SOURCE_DIR"):
        source_dir = Path(os.environ["SCM_TOOLKIT_FLAWLESS_SOURCE_DIR"]).expanduser()
    cache_dir = (cache_root or Path("~/.cache/sweetiebot/flawless-cannon").expanduser()) / REVISION
    files = {name: read_resource(name, source_dir, cache_dir) for name in UPSTREAM}
    return adapt(
        files["js/chat/worked-duration.js"].decode("utf-8"),
        files["css/worked-duration.css"].decode("utf-8"),
        files["artwork/searching-complete.png"],
    )
