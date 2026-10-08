"""Branch-name pack loading, validation, and runtime normalization."""

from __future__ import annotations

import json
import re
from pathlib import Path


HERE = Path(__file__).resolve().parent
CATALOG_PATH = HERE / "branch_name_packs.json"
SAFE_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
LEGACY_PACK_IDS = {
    "g4-founders-power-ponies": "g4-caricatures",
    "g4-characters": "g4-caricatures",
}


def _validate_slug(value: object, label: str) -> str:
    if not isinstance(value, str) or not SAFE_NAME.fullmatch(value):
        raise ValueError(
            f"{label} must be a lowercase branch-safe slug using letters, numbers, and hyphens."
        )
    return value


def _normalize_pack(value: object, context: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{context} must be an object.")

    pack_id = _validate_slug(value.get("id"), f"{context} id")
    label = value.get("label")
    if not isinstance(label, str) or not label.strip():
        raise ValueError(f"{context} label cannot be empty.")

    description = value.get("description", "")
    if not isinstance(description, str):
        raise ValueError(f"{context} description must be text.")

    raw_names = value.get("names")
    if not isinstance(raw_names, list) or not raw_names:
        raise ValueError(f"{context} names must be a non-empty array.")

    names: list[str] = []
    seen_names: set[str] = set()
    for index, raw_name in enumerate(raw_names):
        name = _validate_slug(raw_name, f"{context} name {index + 1}")
        if name in seen_names:
            continue
        seen_names.add(name)
        names.append(name)

    raw_sources = value.get("sources", {})
    if not isinstance(raw_sources, dict):
        raise ValueError(f"{context} sources must be an object when present.")
    sources: dict[str, str] = {}
    for name, source in raw_sources.items():
        if name not in seen_names:
            raise ValueError(f"{context} source key {name!r} is not in names.")
        if not isinstance(source, str) or not source.strip():
            raise ValueError(f"{context} source for {name!r} cannot be empty.")
        sources[name] = source.strip()

    raw_aliases = value.get("aliases", {})
    if not isinstance(raw_aliases, dict):
        raise ValueError(f"{context} aliases must be an object when present.")
    aliases: dict[str, str] = {}
    for old_slug, target in raw_aliases.items():
        old_slug = _validate_slug(old_slug, f"{context} alias")
        target = _validate_slug(target, f"{context} alias target")
        if old_slug in seen_names or target not in seen_names:
            raise ValueError(f"{context} alias {old_slug!r} must point to an existing distinct name.")
        aliases[old_slug] = target

    raw_display_names = value.get("displayNames", {})
    if not isinstance(raw_display_names, dict):
        raise ValueError(f"{context} displayNames must be an object when present.")
    display_names: dict[str, str] = {}
    for slug, display in raw_display_names.items():
        if slug not in seen_names or not isinstance(display, str) or not display.strip():
            raise ValueError(f"{context} display name for {slug!r} must belong to a known name and be nonempty.")
        display_names[slug] = display.strip()

    normalized: dict[str, object] = {
        "id": pack_id,
        "label": label.strip(),
        "description": description.strip(),
        "names": names,
    }
    if sources:
        normalized["sources"] = sources
    if aliases:
        normalized["aliases"] = aliases
    if display_names:
        normalized["displayNames"] = display_names
    return normalized


def _normalize_packs(values: object, context: str) -> list[dict[str, object]]:
    if not isinstance(values, list):
        raise ValueError(f"{context} must be an array of packs.")

    packs: list[dict[str, object]] = []
    seen_ids: set[str] = set()
    for index, raw_pack in enumerate(values):
        pack = _normalize_pack(raw_pack, f"{context} pack {index + 1}")
        pack_id = str(pack["id"])
        if pack_id in seen_ids:
            raise ValueError(f"Duplicate branch-name pack id: {pack_id}")
        seen_ids.add(pack_id)
        packs.append(pack)
    return packs


def load_catalog(path: Path | None = None) -> dict[str, object]:
    source = CATALOG_PATH if path is None else Path(path)
    payload = json.loads(source.read_text())
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("branch_name_packs.json must use schema version 1.")
    return {
        "version": 1,
        "packs": _normalize_packs(payload.get("packs"), "Built-in branch-name packs"),
    }


def parse_imported_packs(raw: object) -> list[dict[str, object]]:
    text = "" if raw is None else str(raw).strip()
    if not text or text == "[]":
        return []
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(
            f"Imported branch-name packs are not valid JSON: {error.msg}."
        ) from error

    if isinstance(payload, dict) and "packs" in payload:
        payload = payload["packs"]
    elif isinstance(payload, dict):
        payload = [payload]
    return _normalize_packs(payload, "Imported branch-name packs")


def merge_catalog(
    base: dict[str, object],
    imported: list[dict[str, object]],
) -> dict[str, object]:
    packs = [dict(pack) for pack in base["packs"]]
    ids = {str(pack["id"]) for pack in packs}
    for pack in imported:
        pack_id = str(pack["id"])
        if pack_id in ids:
            raise ValueError(
                f"Imported branch-name pack id conflicts with a built-in pack: {pack_id}"
            )
        ids.add(pack_id)
        packs.append(dict(pack))
    return {"version": 1, "packs": packs}


def parse_name_list(raw: object) -> list[str]:
    text = "" if raw is None else str(raw)
    names: list[str] = []
    seen: set[str] = set()
    for value in re.split(r"[\s,]+", text.strip()):
        if not value:
            continue
        name = _validate_slug(value, "Custom branch name")
        if name not in seen:
            seen.add(name)
            names.append(name)
    return names


def parse_pack_id_list(raw: object) -> list[str]:
    text = "" if raw is None else str(raw)
    ids: list[str] = []
    seen: set[str] = set()
    for value in re.split(r"[\s,]+", text.strip()):
        if not value:
            continue
        pack_id = _validate_slug(value, "Branch-name pack id")
        pack_id = LEGACY_PACK_IDS.get(pack_id, pack_id)
        if pack_id not in seen:
            seen.add(pack_id)
            ids.append(pack_id)
    return ids


def resolve_runtime_settings(settings: dict[str, object]) -> dict[str, object]:
    runtime = dict(settings)
    catalog = merge_catalog(
        load_catalog(),
        parse_imported_packs(settings.get("branchNameImports", "[]")),
    )
    pack_ids = [str(pack["id"]) for pack in catalog["packs"]]
    known_ids = set(pack_ids)
    enabled_raw = settings.get("branchNameEnabledPacks")
    if enabled_raw is None:
        disabled = [
            pack_id
            for pack_id in parse_pack_id_list(
                settings.get("branchNameDisabledPacks", "")
            )
            if pack_id in known_ids
        ]
    else:
        enabled = set(parse_pack_id_list(enabled_raw)) & known_ids
        disabled = [pack_id for pack_id in pack_ids if pack_id not in enabled]
    runtime["branchNamePacks"] = catalog["packs"]
    runtime["branchNameDisabledPacks"] = disabled
    runtime["branchCustomNames"] = parse_name_list(
        settings.get("branchCustomNames", "")
    )
    runtime.pop("branchNameImports", None)
    runtime.pop("branchNameEnabledPacks", None)
    return runtime
