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


def runtime_files(source_root: Path) -> dict[Path, Path]:
    """Return source-relative paths, including new/unknown file formats.

    Refuse symlinks so a newly added link cannot copy private files from
    outside the extension source tree into a signed installer or VS Code.
    """
    root = Path(source_root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError(f"Invalid extension source directory: {root}")
    files = {}
    for source in root.rglob("*"):
        relative = source.relative_to(root)
        if any(part in IGNORED_DIRECTORIES for part in relative.parts):
            continue
        name = relative.name
        if (name in IGNORED_FILES or name.startswith((".#", "._", ".env."))
                or name == ".env" or name.endswith("~")
                or source.suffix.lower() in IGNORED_SUFFIXES):
            continue
        if source.is_symlink():
            raise ValueError(f"Refusing symlinked extension asset: {source}")
        if source.is_file():
            files[relative] = source
    return dict(sorted(files.items()))
