"""Select all runtime extension assets without a filename-extension allowlist.

Only known local development artifacts, editor swap files, and temporary files
are excluded. New runtime asset formats are packaged without installer edits.
"""

from pathlib import Path

IGNORED_DIRECTORIES = frozenset({
    ".git", ".hg", ".svn", ".idea", ".vscode",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
})
IGNORED_FILES = frozenset({".DS_Store", "Thumbs.db", "desktop.ini", ".coverage"})
IGNORED_SUFFIXES = frozenset({".pyc", ".pyo", ".swp", ".swo", ".tmp", ".temp", ".bak"})


def include_runtime_relative(relative: Path) -> bool:
    """Allow every extension file unless it is explicitly known to be junk."""
    relative = Path(relative)
    if not relative.parts or any(part in IGNORED_DIRECTORIES for part in relative.parts):
        return False
    name = relative.name
    return not (name in IGNORED_FILES or name.startswith((".#", "._", ".env."))
                or name == ".env" or name.endswith("~")
                or relative.suffix.lower() in IGNORED_SUFFIXES)


def runtime_files(source_root: Path, *, allow_missing: bool = False) -> dict[Path, Path]:
    """Return source-relative paths, including new/unknown file formats.

    Refuse symlinks so a newly added link cannot copy private files from
    outside the extension source tree into a signed installer or VS Code.
    Partial updater fixtures may omit extension/; real installs may not.
    """
    root = Path(source_root)
    if root.is_symlink():
        raise ValueError(f"Invalid symlinked extension source directory: {root}")
    if allow_missing and not root.exists():
        return {}
    if not root.is_dir():
        raise ValueError(f"Invalid extension source directory: {root}")
    files = {}
    for source in root.rglob("*"):
        relative = source.relative_to(root)
        if not include_runtime_relative(relative):
            continue
        if source.is_symlink():
            raise ValueError(f"Refusing symlinked extension asset: {source}")
        if source.is_file():
            files[relative] = source
    return dict(sorted(files.items()))
