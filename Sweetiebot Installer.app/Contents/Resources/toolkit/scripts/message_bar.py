"""Message-bar layout definitions shared by the configurator and installer."""

from __future__ import annotations

import json
import re


MESSAGE_BAR_ITEMS = (
    ("branch", "Branch"),
    ("sync", "Sync branch"),
    ("delete", "Delete branch"),
    ("separator-1", "Separator 1"),
    ("autocomplete", "Autocomplete"),
    ("codex", "Codex co-author"),
    ("auto-publish", "Auto-publish"),
    ("separator-2", "Separator 2"),
    ("home", "Home"),
    ("pull-request", "Pull request"),
    ("pony-branch", "Random branch"),
)
MESSAGE_BAR_ITEM_IDS = tuple(item_id for item_id, _label in MESSAGE_BAR_ITEMS)
MESSAGE_BAR_ITEM_LABELS = dict(MESSAGE_BAR_ITEMS)

DEFAULT_MESSAGE_BAR_LAYOUT = {
    "before": ["branch"],
    "after": [
        "sync",
        "delete",
        "separator-1",
        "autocomplete",
        "codex",
        "auto-publish",
        "separator-2",
        "home",
        "pull-request",
        "pony-branch",
    ],
}
DEFAULT_MESSAGE_BAR_LAYOUT_JSON = json.dumps(
    DEFAULT_MESSAGE_BAR_LAYOUT, separators=(",", ":")
)


def parse_message_bar_layout(raw: object) -> dict[str, list[str]]:
    """Validate a saved layout and return a normalized before/after mapping."""
    try:
        payload = json.loads(str(raw))
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("Message bar layout is not valid JSON.") from error

    if not isinstance(payload, dict):
        raise ValueError("Message bar layout must contain before and after lists.")

    known = set(MESSAGE_BAR_ITEM_IDS)
    seen: set[str] = set()
    normalized: dict[str, list[str]] = {}
    for zone in ("before", "after"):
        values = payload.get(zone, [])
        if not isinstance(values, list):
            raise ValueError(f"Message bar {zone} controls must be a list.")
        items: list[str] = []
        for value in values:
            if not isinstance(value, str) or (value not in known and not re.fullmatch(r"separator-[1-9][0-9]*", value)):
                raise ValueError(f"Unknown message bar control: {value}")
            if value in seen:
                raise ValueError(f"Message bar control appears more than once: {value}")
            seen.add(value)
            items.append(value)
        normalized[zone] = items
    return normalized


def serialize_message_bar_layout(raw: object) -> str:
    return json.dumps(parse_message_bar_layout(raw), separators=(",", ":"))
