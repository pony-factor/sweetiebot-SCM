"""Cleanup for the retired Sweetie Bot Codex composer patch."""

import json
import re
from pathlib import Path

START = '\n/* scm-toolkit-codex-composer:start */\n'
END = '\n/* scm-toolkit-codex-composer:end */\n'


def transform(source):
    """Remove the retired composer patch and restore any replaced source text."""
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError("Incomplete Codex composer patch.")
    if START not in source:
        return source

    before, rest = source.split(START, 1)
    payload, after = rest.split(END, 1)
    source = before + after
    metadata = re.search(r"^/\\* edits:(.*?) \\*/$", payload, re.MULTILINE)
    if metadata is None:
        raise ValueError("Codex composer patch is missing edit metadata.")

    for original, replacement in reversed(json.loads(metadata[1])):
        if source.count(replacement) != 1:
            raise ValueError("Installed Codex composer patch changed.")
        source = source.replace(replacement, original, 1)
    return source


def patch_files(extension_path=None):
    """Yield only Codex webview bundles that still contain the retired patch."""
    candidates = (
        [Path(extension_path)]
        if extension_path
        else sorted((Path.home() / ".vscode/extensions").glob("openai.chatgpt-*"), reverse=True)
    )
    for candidate in candidates:
        for path in (candidate / "webview/assets").glob("app-initial-*.js"):
            original = path.read_text()
            if START in original:
                yield path, original, transform(original)
