#!/usr/bin/env python3
"""Install or remove the Sweetiebot SCM companion extension."""

from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path

from toolkit_settings import load_settings, VSCODE_SETTINGS

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "efs"
STANDALONE_CONTAINER_ID = "scmToolkit-workspaceSearchContainer"
LEGACY_EXTENSION_PATTERNS = ("jfwooten4.scm-toolkit-workspace-search-*",)


def extension_version() -> str:
    return json.loads((SOURCE / "package.json").read_text())["version"]


def extension_identity() -> str:
    package = json.loads((SOURCE / "package.json").read_text())
    return f'{package["publisher"]}.{package["name"]}'


def default_extensions_dir() -> Path:
    configured = os.environ.get("SWEETIEBOT_VSCODE_EXTENSIONS_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".vscode/extensions"


def extension_destination(extensions_dir: Path | None = None) -> Path:
    root = Path(extensions_dir) if extensions_dir is not None else default_extensions_dir()
    return root / f"{extension_identity()}-{extension_version()}"


def render_package(settings: dict[str, object] | None = None) -> dict[str, object]:
    settings = load_settings() if settings is None else settings
    package = json.loads((SOURCE / "package.json").read_text())
    contributes = package["contributes"]
    workspace_view = contributes["views"]["scm"][0]
    companion_views = contributes["views"]["scm"][1:]
    workspace_view["name"] = str(settings["workspaceSearchLabel"])
    workspace_view["contextualTitle"] = str(settings["workspaceSearchLabel"])
    properties = contributes["configuration"]["properties"]
    properties["scmToolkit.workspaceSearch.askOllama"]["default"] = bool(
        settings["workspaceSearchAskOllama"]
    )
    properties["scmToolkit.workspaceSearch.chatModel"]["default"] = str(
        settings["workspaceSearchChatModel"]
    )

    properties["scmToolkit.workspaceSearch.embeddingModel"]["default"] = str(
        settings["workspaceSearchEmbeddingModel"]
    )

    for group, root in (("workspaceSearch", "scmToolkit.workspaceSearch"), ("vscodeSettings", "scmToolkit")):
        for key, name in VSCODE_SETTINGS[group].items():
            if name not in settings:
                continue
            prop = properties[f"{root}.{key}"]
            value = settings[name]
            if prop["type"] == "integer":
                value = int(value)
            elif prop["type"] == "number":
                value = float(value)
            prop["default"] = value

    if settings["workspaceSearchActivityBar"]:
        contributes["viewsContainers"] = {
            "activitybar": [
                {
                    "id": STANDALONE_CONTAINER_ID,
                    "title": str(settings["workspaceSearchLabel"]),
                    "icon": "media/efs.svg",
                }
            ]
        }
        contributes["views"] = {STANDALONE_CONTAINER_ID: [workspace_view], "scm": companion_views}
    else:
        contributes.pop("viewsContainers", None)
        contributes["views"] = {"scm": [workspace_view, *companion_views]}

    return package


def source_files(root: Path | None = None) -> dict[Path, Path]:
    here = root / "scripts" if root is not None else HERE
    source_root = root / "efs" if root is not None else SOURCE
    files = {
        path.relative_to(source_root): path
        for path in source_root.rglob("*")
        if path.is_file()
    }
    files[Path("prune_merged_branches.py")] = here / "prune_merged_branches.py"
    files[Path("configurator.py")] = here / "configurator.py"
    files[Path("codex_sticker.py")] = here / "codex_sticker.py"
    files[Path("commit_diagnostics_dashboard.py")] = here / "commit_diagnostics_dashboard.py"
    files[Path("commit_hotkey.py")] = here / "commit_hotkey.py"
    files[Path("toolkit_settings.py")] = here / "toolkit_settings.py"
    files[Path("message_bar.py")] = here / "message_bar.py"
    files[Path("message_bar_configurator.py")] = here / "message_bar_configurator.py"
    files[Path("codex_colors.py")] = here / "codex_colors.py"
    files[Path("ai_commit.py")] = here / "ai_commit.py"
    files[Path("background_commit.py")] = here / "background_commit.py"
    files[Path("merged_branch.py")] = here / "merged_branch.py"
    files[Path("post_commit_spellcheck.py")] = here / "post_commit_spellcheck.py"
    files[Path("sweetiebot_async_commit.py")] = here / "sweetiebot_async_commit.py"
    files[Path("sweetiebot_diagnostics.py")] = here / "sweetiebot_diagnostics.py"
    files[Path("local_codex_commit.py")] = here / "local_codex_commit.py"
    files[Path("branch_names.py")] = here / "branch_names.py"
    files[Path("branch_name_packs.json")] = here / "branch_name_packs.json"
    files[Path("local_setup.py")] = here / "local_setup.py"
    # Preserve the installer's relative asset layout for update-time repair.
    for directory, suffixes in (("scripts", {".py", ".json"}), ("assets/codex", {".js", ".css"}), ("assets/imgs", {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico"}), ("assets/browser", {".js"}), ("assets/github", {".js"}), ("assets/workbench", {".js", ".css"}), ("efs", {".js", ".json", ".svg", ".md", ".html"})):
        for source in (here.parent / directory).rglob("*"):
            if source.is_file() and source.suffix.lower() in suffixes:
                files[Path("codex-customizations") / source.relative_to(here.parent)] = source
    return dict(sorted(files.items()))


def expected_bytes(
    relative: Path,
    source: Path,
    settings: dict[str, object],
) -> bytes:
    if relative == Path("package.json"):
        return (json.dumps(render_package(settings), indent=2) + "\n").encode()
    return source.read_bytes()


def destination_matches(
    destination: Path,
    settings: dict[str, object] | None = None,
) -> bool:
    if not destination.is_dir():
        return False
    settings = load_settings() if settings is None else settings
    sources = source_files()
    expected = set(sources)
    # The running Python configurator may have generated bytecode in this
    # extension folder. Those caches are not part of the managed install and
    # must not cause a wholesale reinstall or a chain of VS Code reloads.
    actual = {
        path.relative_to(destination)
        for path in destination.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.relative_to(destination).parts
        and path.suffix not in {".pyc", ".pyo"}
    }
    if expected != actual:
        return False
    return all(
        expected_bytes(relative, source, settings) == (destination / relative).read_bytes()
        for relative, source in sources.items()
    )


def installed_versions(extensions_dir: Path) -> list[Path]:
    if not extensions_dir.is_dir():
        return []
    patterns = (f"{extension_identity()}-*", *LEGACY_EXTENSION_PATTERNS)
    return sorted({path for pattern in patterns for path in extensions_dir.glob(pattern)})


def remove_legacy_extensions(extensions_dir: Path | None = None, *, check=False) -> bool:
    root = Path(extensions_dir) if extensions_dir is not None else default_extensions_dir()
    stale = sorted({path for pattern in LEGACY_EXTENSION_PATTERNS for path in root.glob(pattern)})
    registry = root / "extensions.json"
    entries = json.loads(registry.read_text()) if registry.exists() else []
    kept = [entry for entry in entries if entry.get("identifier", {}).get("id", "").lower()
            != "jfwooten4.scm-toolkit-workspace-search"]
    changed = bool(stale) or kept != entries
    if check:
        return changed
    if kept != entries:
        # Keep the current extension and all unrelated registrations intact.
        registry.write_text(json.dumps(kept) + "\n")
    for old in stale:
        if old.is_symlink():
            old.unlink()
        elif old.exists():
            shutil.rmtree(old)
    return changed


def sync_extension(
    *,
    remove: bool = False,
    check: bool = False,
    extensions_dir: Path | None = None,
    settings: dict[str, object] | None = None,
) -> bool:
    root = Path(extensions_dir) if extensions_dir is not None else default_extensions_dir()
    destination = extension_destination(root)
    stale = [path for path in installed_versions(root) if path != destination]
    legacy_changed = remove_legacy_extensions(root, check=check)

    if remove:
        targets = [path for path in installed_versions(root) if path.exists()]
        if check:
            return legacy_changed or bool(targets)
        for target in targets:
            if target.is_symlink():
                target.unlink()
            else:
                shutil.rmtree(target)
        return legacy_changed or bool(targets)

    settings = load_settings() if settings is None else settings
    changed = legacy_changed or bool(stale) or not destination_matches(destination, settings=settings)
    if check or not changed:
        return changed

    root.mkdir(parents=True, exist_ok=True)
    for old in stale:
        if old.is_symlink():
            old.unlink()
        elif old.exists():
            shutil.rmtree(old)
    temp = root / f".{destination.name}.tmp"
    if temp.exists():
        shutil.rmtree(temp)
    shutil.copytree(SOURCE, temp)
    for relative, source in source_files().items():
        if relative.parent != Path("."):
            (temp / relative.parent).mkdir(parents=True, exist_ok=True)
        if relative == Path("package.json"):
            (temp / relative).write_bytes(expected_bytes(relative, source, settings))
        else:
            shutil.copy2(source, temp / relative)
    if destination.exists():
        if destination.is_symlink():
            destination.unlink()
        else:
            shutil.rmtree(destination)
    temp.rename(destination)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true", help="Remove Workspace Search")
    parser.add_argument("--check", action="store_true", help="Check whether installation would change anything")
    parser.add_argument("--extensions-dir", type=Path, help="Override the VS Code extensions directory")
    args = parser.parse_args()

    settings = load_settings()
    changed = sync_extension(
        remove=args.uninstall,
        check=args.check,
        extensions_dir=args.extensions_dir,
        settings=settings,
    )
    if args.check:
        print("Workspace Search needs an update." if changed else "Workspace Search is up to date.")
        return
    if args.uninstall:
        print("Removed Workspace Search." if changed else "Workspace Search was not installed.")
        return
    destination = extension_destination(args.extensions_dir)
    print(f"Installed Workspace Search to {destination}.")
    if settings["workspaceSearchActivityBar"]:
        print(
            "Reload or restart Visual Studio Code, then open "
            f'{settings["workspaceSearchLabel"]} from the Activity Bar.'
        )
    else:
        print("Reload or restart Visual Studio Code, then open Source Control → Workspace Search.")


if __name__ == "__main__":
    main()
