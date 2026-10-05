#!/usr/bin/env python3
"""Remove the retired Sweetie Bot Codex composer patch from installed extensions."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

START = '\n/* scm-toolkit-codex-composer:start */\n'
END = '\n/* scm-toolkit-codex-composer:end */\n'


def transform(source: str) -> str:
    """Remove the retired composer payload and restore any source it replaced."""
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError("Incomplete Codex composer patch.")
    if START not in source:
        return source

    before, rest = source.split(START, 1)
    payload, after = rest.split(END, 1)
    source = before + after
    metadata = re.search(r"^/\* edits:(.*?) \*/$", payload, re.MULTILINE)
    if metadata is None:
        raise ValueError("Codex composer patch is missing edit metadata.")

    for original, replacement in reversed(json.loads(metadata[1])):
        if source.count(replacement) != 1:
            raise ValueError("Installed Codex composer patch changed.")
        source = source.replace(replacement, original, 1)
    return source


def patch_files(extension_path: Path | None = None):
    """Yield only Codex webview bundles that still contain the retired patch."""
    candidates = (
        [Path(extension_path)]
        if extension_path is not None
        else sorted((Path.home() / ".vscode/extensions").glob("openai.chatgpt-*"), reverse=True)
    )
    for candidate in candidates:
        for path in (candidate / "webview/assets").glob("app-initial-*.js"):
            original = path.read_text()
            if START in original:
                yield path, original, transform(original)


def repair(extension_path: Path | None = None) -> list[Path]:
    """Validate every affected bundle first, then remove the retired patch."""
    patches = list(patch_files(extension_path))
    for path, original, _ in patches:
        if path.read_text() != original:
            raise RuntimeError(f"Codex bundle changed during validation: {path}")

    written: list[tuple[Path, str]] = []
    try:
        for path, original, restored in patches:
            written.append((path, original))
            path.write_text(restored)
    except OSError:
        for path, original in reversed(written):
            try:
                path.write_text(original)
            except OSError:
                pass
        raise
    return [path for path, _, _ in patches]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Remove Sweetie Bot's retired Codex composer patch from installed OpenAI extensions."
    )
    parser.add_argument(
        "--extension",
        type=Path,
        help="Repair one OpenAI Codex VS Code extension directory instead of scanning ~/.vscode/extensions.",
    )
    args = parser.parse_args()
    repaired = repair(args.extension)
    if repaired:
        for path in repaired:
            print(f"Restored {path}")
        print("Reload Visual Studio Code to start Codex with the restored webview bundle.")
    else:
        print("No retired Sweetie Bot Codex composer patch was found.")


if __name__ == "__main__":
    main()
