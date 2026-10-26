#!/usr/bin/env python3
"""Reversible Sweetiebot composer controls for Codex webview bundles."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

START = '\n/* scm-toolkit-codex-composer:start */\n'
END = '\n/* scm-toolkit-codex-composer:end */\n'
LAYOUT_START = '\n/* scm-toolkit-codex-inline-location:start */\n'
LAYOUT_END = '\n/* scm-toolkit-codex-inline-location:end */\n'
PASTE_START = '\n/* scm-toolkit-codex-clipboard:start */\n'
PASTE_END = '\n/* scm-toolkit-codex-clipboard:end */\n'
PASTE_ASSET = Path(__file__).resolve().parent.parent / 'assets/codex/clipboard-submit.js'
WING_ASSET = Path(__file__).resolve().parent.parent / 'assets/codex/send-wing.js'
WING_START = '\n/* scm-toolkit-codex-send-wing:start */\n'
WING_END = '\n/* scm-toolkit-codex-send-wing:end */\n'
ASSET = Path(__file__).resolve().parent.parent / 'assets/codex/composer-controls.js'
PLACEHOLDER_START = '\n/* scm-toolkit-codex-placeholders:start\n'
PLACEHOLDER_END = '\nscm-toolkit-codex-placeholders:end */\n'
PLACEHOLDER_DISPLAY_START = '\n/* scm-toolkit-codex-placeholder-display:start */\n'
PLACEHOLDER_DISPLAY_END = '\n/* scm-toolkit-codex-placeholder-display:end */\n'


def runtime_payload(name: str, payload: str) -> str:
    """Defer optional DOM work so it cannot abort native module evaluation."""
    label = json.dumps('Sweetiebot: optional ' + name + ' unavailable')
    return (";(() => {\n"
            "const report = () => { try { console.warn(" + label + "); } catch {} };\n"
            "const start = () => { try {\n" + payload + "\n} catch { report(); } };\n"
            "try { if (typeof document === 'undefined') return;\n"
            "const defer = () => setTimeout(start, 0);\n"
            "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', defer, {once:true});\n"
            "else defer(); } catch { report(); }\n"
            "})();\n")


def transform_placeholders(source: str, settings: dict) -> str:
    """Replace native placeholder expressions with reversible plain text literals."""
    if source.count(PLACEHOLDER_DISPLAY_START) != source.count(PLACEHOLDER_DISPLAY_END) or source.count(PLACEHOLDER_DISPLAY_START) > 1:
        raise ValueError("Incomplete Codex placeholder display patch.")
    if PLACEHOLDER_DISPLAY_START in source:
        before, rest = source.split(PLACEHOLDER_DISPLAY_START, 1)
        _, after = rest.split(PLACEHOLDER_DISPLAY_END, 1)
        source = before + after
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
        pattern = (r'(?<![\w$])[\w$]+\.formatMessage\(\{id:`' + re.escape(key)
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
        payload = (ASSET.parent / 'placeholders.js').read_text().replace(
            '__SCM_TOOLKIT_PLACEHOLDERS__', json.dumps([
                str(settings.get(name, '')).strip()
                for name in ('codexNewChatPlaceholder', 'codexFollowUpPlaceholder')
                if str(settings.get(name, '')).strip()
            ], ensure_ascii=True))
        source += PLACEHOLDER_DISPLAY_START + runtime_payload('placeholders', payload) + PLACEHOLDER_DISPLAY_END
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


def clipboard_module(bundle_path: Path) -> str | None:
    """Resolve Codex's native app-service facade without depending on its build hash."""
    matches = [path for path in bundle_path.parent.glob('*.js')
               if re.search(r'export\{[^}]*\bas appServices\b', path.read_text())]
    if len(matches) != 1:
        # Browser clipboard remains available on an explicit user action.
        return None
    return './' + matches[0].name


def transform_layout(source: str, inline: bool = True, paste_button: bool = False,
                     native_clipboard_module: str | None = None, wing_button: bool = False) -> str:
    """Place the native computer/usage control beside access without changing React source."""
    source = transform(source)
    if source.count(LAYOUT_START) != source.count(LAYOUT_END) or source.count(LAYOUT_START) > 1:
        raise ValueError("Incomplete Codex inline-location patch.")
    if LAYOUT_START in source:
        before, rest = source.split(LAYOUT_START, 1)
        _, after = rest.split(LAYOUT_END, 1)
        source = before + after
    if source.count(PASTE_START) != source.count(PASTE_END) or source.count(PASTE_START) > 1:
        raise ValueError("Incomplete Codex clipboard patch.")
    if PASTE_START in source:
        before, rest = source.split(PASTE_START, 1)
        payload, after = rest.split(PASTE_END, 1)
        source = before + after
        metadata = re.search(r'^/\* edits:(.*?) \*/$', payload, re.MULTILINE)
        if metadata is None:
            raise ValueError('Codex clipboard patch is missing restoration metadata.')
        for original, replacement in reversed(json.loads(metadata[1])):
            if source.count(replacement) != 1:
                raise ValueError('Installed Codex clipboard editor hook changed.')
            source = source.replace(replacement, original, 1)
    is_composer = 'composer.placeholder.localFollowUp.locally' in source
    if source.count(WING_START) != source.count(WING_END) or source.count(WING_START) > 1:
        raise ValueError('Incomplete Codex send wing patch.')
    if WING_START in source:
        before, rest = source.split(WING_START, 1)
        _, after = rest.split(WING_END, 1)
        source = before + after
    editor_anchor = r'this\.dictation=new [\w$]+\([\w$]+,\(\)=>this\.isInputActive\)\}'
    if is_composer or re.search(editor_anchor, source):
        if wing_button and is_composer:
            source += WING_START + ';\n' + runtime_payload('send wing', WING_ASSET.read_text()) + WING_END
        if inline and is_composer:
            source += LAYOUT_START + ';\n' + runtime_payload('composer layout', ASSET.read_text()) + LAYOUT_END
        if paste_button:
            edits = []
            anchors = list(re.finditer(editor_anchor, source))
            if len(anchors) > 1:
                raise ValueError('Codex native clipboard editor could not be identified uniquely.')
            if anchors:
                original = anchors[0][0]
                replacement = original[:-1] + ';try{this.view.dom.__scmToolkitComposer=this}catch{}}'
                source = source.replace(original, replacement, 1)
                edits.append([original, replacement])
            payload = PASTE_ASSET.read_text().replace(
                'null /* scm-toolkit-native-clipboard */',
                json.dumps(native_clipboard_module) + ' /* scm-toolkit-native-clipboard */')
            if not is_composer:
                payload = ''
            source += PASTE_START + ';\n/* edits:' + json.dumps(edits) + ' */\n' + (runtime_payload('clipboard control', payload) if payload else '') + PASTE_END
    return source


def patch_files(extension_path: Path | None = None, inline: bool | None = None, paste_button: bool = False, wing_button: bool = False):
    """Yield only Codex webview bundles that still contain the retired patch."""
    candidates = (
        [Path(extension_path)]
        if extension_path is not None
        else sorted((Path.home() / ".vscode/extensions").glob("openai.chatgpt-*"), reverse=True)
    )
    for candidate in candidates:
        for path in (candidate / "webview/assets").glob("*.js"):
            original = path.read_text()
            if inline is None:
                if START in original:
                    yield path, original, transform(original)
            elif START in original or LAYOUT_START in original or PASTE_START in original or WING_START in original or 'id:`composer.placeholder.localFollowUp.locally`' in original or (paste_button and 'this.dictation=new ' in original and re.search(r'this\.dictation=new [\w$]+\([\w$]+,\(\)=>this\.isInputActive\)\}', original)):
                module = clipboard_module(path) if paste_button else None
                yield path, original, transform_layout(original, inline, paste_button, module, wing_button)


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
