"""Reversible label customization for the installed OpenAI Codex sidebar."""

from __future__ import annotations

import json
from pathlib import Path

MARKER = "_sweetiebotOriginalCodexWindowLabel"
CONTAINERS = frozenset(("codexViewContainer", "codexSecondaryViewContainer"))
SIDEBAR_VIEW = "chatgpt.sidebarView"


def _slots(manifest):
    """Yield the Codex view-container and chat-view labels, not other UI strings."""
    contributes = manifest.get("contributes", {})
    for location, entries in contributes.get("viewsContainers", {}).items():
        for item in entries:
            if item.get("id") in CONTAINERS and isinstance(item.get("title"), str):
                yield ("container", location, item["id"], item, "title")
    for container, entries in contributes.get("views", {}).items():
        if container in CONTAINERS:
            for item in entries:
                if item.get("id") == SIDEBAR_VIEW and isinstance(item.get("name"), str):
                    yield ("view", container, SIDEBAR_VIEW, item, "name")


def _validate_label(label):
    if not isinstance(label, str):
        raise ValueError("Codex window label must be text.")
    label = label.strip()
    if not label or len(label) > 80 or any(char in label for char in "\\r\\n\\0"):
        raise ValueError("Codex window label must be 1–80 characters on one line.")
    return label


def transform(source: str, label: str = "Codex", remove: bool = False) -> str:
    """Restore prior values before applying a new label; preserve unrelated fields."""
    label = _validate_label(label)
    manifest = json.loads(source)
    if (str(manifest.get("publisher", "")).lower(), manifest.get("name")) != ("openai", "chatgpt"):
        raise ValueError("Not an OpenAI Codex extension manifest.")

    originals = manifest.get(MARKER)
    if originals is None and (remove or label == "Codex"):
        return source

    slots = {(kind, parent, identity): (item, field)
             for kind, parent, identity, item, field in _slots(manifest)}
    if originals is not None:
        if not isinstance(originals, dict) or not isinstance(originals.get("entries"), list):
            raise ValueError("Invalid Sweetie Bot Codex label restoration metadata.")
        previous_label = originals.get("label")
        if not isinstance(previous_label, str):
            raise ValueError("Invalid Sweetie Bot Codex label restoration value.")
        for entry in originals["entries"]:
            try:
                kind, parent, identity, value = entry
                item, field = slots[(kind, parent, identity)]
            except (ValueError, TypeError, KeyError) as error:
                raise ValueError("Codex sidebar layout changed; cannot safely restore labels.") from error
            if item[field] != previous_label:
                raise ValueError("Codex sidebar label changed outside Sweetie Bot; refusing to overwrite it.")
            item[field] = value
        del manifest[MARKER]

    if not remove and label != "Codex":
        if not slots:
            raise ValueError("Unsupported Codex extension: sidebar label entries were not found.")
        entries = []
        for (kind, parent, identity), (item, field) in slots.items():
            entries.append([kind, parent, identity, item[field]])
            item[field] = label
        manifest[MARKER] = {"label": label, "entries": entries}

    indent = 2 if "\\n" in source else None
    serialized = json.dumps(manifest, ensure_ascii=False, indent=indent)
    return serialized + ("\\n" if source.endswith("\\n") else "")


def manifest_path(extension_path=None):
    candidates = ([Path(extension_path)] if extension_path is not None
                  else sorted((Path.home() / ".vscode/extensions").glob("openai.chatgpt-*"), reverse=True))
    for candidate in candidates:
        path = candidate / "package.json"
        if not path.is_file():
            continue
        try:
            manifest = json.loads(path.read_text())
        except (ValueError, OSError):
            continue
        if (str(manifest.get("publisher", "")).lower(), manifest.get("name")) == ("openai", "chatgpt"):
            return path
    return None


def patch_file(extension_path=None, label="Codex", remove=False):
    label = _validate_label(label)
    path = manifest_path(extension_path)
    if path is None:
        if label != "Codex" and not remove:
            raise ValueError("The installed OpenAI Codex extension manifest was not found.")
        return None
    original = path.read_text()
    return (path, original, transform(original, label, remove=remove))
