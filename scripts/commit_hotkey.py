"""Manage Sweetiebot's VS Code Commit keybinding without rewriting unrelated JSONC."""
from __future__ import annotations

import json
import os
import re
import stat
import tempfile
from pathlib import Path

COMMAND = "sweetiebot.commit"
VALID_KEY = re.compile(
    r"(?:(?:ctrl|shift|alt|cmd)\+)*(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4])|"
    r"space|enter|tab|escape|backspace|delete|home|end|pageup|pagedown|"
    r"up|down|left|right|insert|backquote|minus|equal|bracketleft|"
    r"bracketright|backslash|semicolon|quote|comma|period|slash)$"
)


def _jsonc(text):
    """Strip comments and trailing commas while preserving all character offsets."""
    chars = list(text)
    i = 0
    quoted = False
    while i < len(chars):
        if quoted:
            if chars[i] == "\\":
                i += 2
                continue
            if chars[i] == '"':
                quoted = False
        elif chars[i] == '"':
            quoted = True
        elif text.startswith("//", i):
            j = text.find("\n", i)
            j = len(text) if j < 0 else j
            chars[i:j] = " " * (j - i)
            i = j
            continue
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j < 0:
                raise ValueError("Unterminated keybindings.json comment.")
            j += 2
            chars[i:j] = " " * (j - i)
            i = j
            continue
        i += 1
    plain = "".join(chars)
    for match in re.finditer(r",(?=\s*[}\]])", plain):
        chars[match.start()] = " "
    return "".join(chars)


def _entries(text):
    clean = _jsonc(text)
    try:
        bindings = json.loads(clean)
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid keybindings.json: {error.msg}") from error
    if not isinstance(bindings, list) or not all(isinstance(item, dict) for item in bindings):
        raise ValueError("keybindings.json must be an array of shortcuts.")
    opening, closing = clean.find("["), clean.rfind("]")
    spans, start, depth, quoted, escaped = [], None, 0, False, False
    for i in range(opening + 1, closing):
        ch = clean[i]
        if quoted:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                quoted = False
        elif ch == '"':
            quoted = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                spans.append((start, i + 1))
    if depth or len(spans) != len(bindings):
        raise ValueError("Unsupported keybindings.json structure.")
    return clean, bindings, spans, opening, closing


def read_commit_hotkey(path: Path) -> str:
    if path.is_symlink():
        raise ValueError("Refusing a symlinked keybindings.json.")
    if not path.exists():
        return ""
    _, bindings, _, _, _ = _entries(path.read_text(encoding="utf-8-sig"))
    keys = [str(item.get("key", "")) for item in bindings if item.get("command") == COMMAND]
    return keys[-1] if keys else ""


def _remove(text, clean, start, end):
    # Check the original source here: JSONC sanitization masks trailing commas,
    # and must never make us consume a preceding inline comment instead.
    after = end
    while after < len(text) and text[after].isspace():
        after += 1
    if after < len(text) and text[after] == ",":
        return text[:start] + text[after + 1:]
    before = start - 1
    while before >= 0 and clean[before].isspace():
        before -= 1
    if before >= 0 and clean[before] == ",":
        return text[:before] + text[before + 1:start] + text[end:]
    return text[:start] + text[end:]


def update_commit_hotkey(path: Path, key: str) -> str:
    key = key.lower().strip()
    if key:
        if not VALID_KEY.fullmatch(key) or len(key.split("+")[:-1]) != len(set(key.split("+")[:-1])):
            raise ValueError("Unsupported shortcut. Record one key combination.")
    if path.is_symlink():
        raise ValueError("Refusing a symlinked keybindings.json.")
    existed = path.exists()
    before = path.read_text(encoding="utf-8-sig") if existed else "[]\n"
    text = before
    clean, bindings, spans, _, _ = _entries(text)
    if key:
        for item in bindings:
            if str(item.get("key", "")).lower() == key and item.get("command") not in {COMMAND, "-" + COMMAND}:
                raise ValueError(f"Shortcut already used by {item.get('command', 'another command')}. Choose another.")
    owned = [item for item in bindings if item.get("command") == COMMAND]
    if not owned and not key:
        return ""
    if len(owned) == 1 and owned[0].get("key") == key and not owned[0].get("when"):
        return key
    for (start, end), item in reversed(list(zip(spans, bindings))):
        if item.get("command") == COMMAND:
            text = _remove(text, clean, start, end)
    if key:
        clean, _, spans, opening, closing = _entries(text)
        entry = json.dumps({"key": key, "command": COMMAND})
        if spans:
            end = spans[-1][1]
            cursor = end
            while cursor < closing and clean[cursor].isspace():
                cursor += 1
            if cursor < closing and clean[cursor] == ",":
                text = text[:cursor + 1] + "\n  " + entry + text[cursor + 1:]
            else:
                text = text[:end] + ",\n  " + entry + text[end:]
        else:
            text = text[:opening + 1] + "\n  " + entry + "\n" + text[opening + 1:]
    _entries(text)  # Never write malformed JSONC.
    if text == before:
        return key
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if existed else 0o600
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                         prefix=".sweetiebot-keys-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        if path.is_symlink() or (path.read_text(encoding="utf-8-sig") if path.exists() else "[]\n") != before:
            raise RuntimeError("Keybindings changed during editing. Try again.")
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return key
