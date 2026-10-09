#!/usr/bin/env python3
"""Remove the retired Sweetie Bot Codex composer patch from installed extensions."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

START = '\n/* scm-toolkit-codex-composer:start */\n'
END = '\n/* scm-toolkit-codex-composer:end */\n'
LAYOUT_START = '\n/* scm-toolkit-codex-inline-location:start */\n'
LAYOUT_END = '\n/* scm-toolkit-codex-inline-location:end */\n'
ASSET = Path(__file__).resolve().parent.parent / 'assets/codex/codex-composer-controls.js'
PLACEHOLDER_START = '\n/* scm-toolkit-codex-placeholders:start\n'
PLACEHOLDER_END = '\nscm-toolkit-codex-placeholders:end */\n'


def transform_placeholders(source: str, settings: dict) -> str:
    """Replace native placeholder expressions with reversible plain text literals."""
    if source.count(PLACEHOLDER_START) != source.count(PLACEHOLDER_END) or source.count(PLACEHOLDER_START) > 1:
        raise ValueError("Incomplete Codex placeholder patch.")
    if PLACEHOLDER_START in source:
        before, rest = source.split(PLACEHOLDER_START, 1)
        metadata, after = rest.split(PLACEHOLDER_END, 1)
        source = before + after
        for original, replacement in reversed(json.loads(metadata)):
            if source.count(replacement) != 1:
                raise ValueError("Installed Codex placeholder patch changed.")
            source = source.replace(replacement, original, 1)
    edits = []
    for name, key in (
        ("codexNewChatPlaceholder", "homePage.composer.placeholder.askAnything.v2"),
        ("codexFollowUpPlaceholder", "composer.placeholder.localFollowUp.locally"),
    ):
        value = str(settings.get(name, "")).strip()
        if not value:
            continue
        pattern = (r'[\w$]+\.formatMessage\(\{id:`' + re.escape(key)
                   + r'`,defaultMessage:`(?:\\.|[^`])*`,description:`(?:\\.|[^`])*`\}\)')
        matches = list(re.finditer(pattern, source))
        if len(matches) != 1:
            raise ValueError(f"Codex placeholder {key} could not be identified uniquely.")
        original = matches[0][0]
        replacement = '(' + json.dumps(value, ensure_ascii=True) + f'/* scm-toolkit:{name} */)'
        source = source.replace(original, replacement, 1)
        edits.append([original, replacement])
    if edits:
        metadata = json.dumps(edits, ensure_ascii=True).replace('*', '\\u002a')
        source += PLACEHOLDER_START + metadata + PLACEHOLDER_END
    return source


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


def transform_layout(source: str, inline: bool = True) -> str:
    """Place the native computer/usage control beside access without changing React source."""
    source = transform(source)
    if source.count(LAYOUT_START) != source.count(LAYOUT_END) or source.count(LAYOUT_START) > 1:
        raise ValueError("Incomplete Codex inline-location patch.")
    if LAYOUT_START in source:
        before, rest = source.split(LAYOUT_START, 1)
        _, after = rest.split(LAYOUT_END, 1)
        source = before + after
    if inline and 'composer.placeholder.localFollowUp.locally' in source:
        source += LAYOUT_START + ';\n' + ASSET.read_text() + LAYOUT_END
    return source


def patch_files(extension_path: Path | None = None, inline: bool | None = None):
    """Yield only Codex webview bundles that still contain the retired patch."""
    candidates = (
        [Path(extension_path)]
        if extension_path is not None
        else sorted((Path.home() / ".vscode/extensions").glob("openai.chatgpt-*"), reverse=True)
    )
    for candidate in candidates:
        for path in (candidate / "webview/assets").glob("app-initial-*.js"):
            original = path.read_text()
            if inline is None:
                if START in original:
                    yield path, original, transform(original)
            elif START in original or LAYOUT_START in original or 'composer.placeholder.localFollowUp.locally' in original:
                yield path, original, transform_layout(original, inline)


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
