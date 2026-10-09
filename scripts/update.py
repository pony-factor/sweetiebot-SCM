"""Fetch published toolkit sources in an isolated cache for automatic repair."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import tarfile
from pathlib import Path
from workspace_search import default_extensions_dir

REMOTE = "https://github.com/pony-factor/sweetiebot-SCM.git"
FORMATS = {
    "scripts": {".py", ".json"},
    "efs": {".js", ".json", ".svg", ".md"},
    "assets/workbench": {".js", ".css"},
    "assets/codex": {".js", ".css"},
    "assets/browser": {".js"},
}


def git(repository, *arguments):
    return subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-C", str(repository), *arguments],
        check=True, capture_output=True, timeout=30,
    ).stdout


def extract_sources(archive, destination):
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        for member in files:
            relative = Path(member.name)
            if relative.is_absolute() or ".." in relative.parts or not member.isfile():
                continue
            if not any(relative.is_relative_to(folder) and relative.suffix in suffixes
                       for folder, suffixes in FORMATS.items()):
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with files.extractfile(member) as source:
                target.write_bytes(source.read())


def installed_sources_match(candidate, extensions_dir):
    """Verify the installed repair payload instead of trusting a revision marker."""
    package = json.loads((candidate / "efs/package.json").read_text())
    destination = extensions_dir / f'{package["publisher"]}.{package["name"]}-{package["version"]}'
    payload = destination / "codex-customizations"
    for source in candidate.rglob("*"):
        if not source.is_file():
            continue
        target = payload / source.relative_to(candidate)
        if target.is_symlink() or not target.is_file() or target.read_bytes() != source.read_bytes():
            return False
    return True


def prepare_update(cache, extensions_dir=None):
    repository = cache / "upstream.git"
    if not repository.exists():
        repository.mkdir(parents=True)
        git(repository, "init", "--bare")
    git(repository, "fetch", "--depth=1", "--no-tags", REMOTE, "refs/heads/main")
    revision = git(repository, "rev-parse", "FETCH_HEAD").decode().strip()
    marker = cache / "installed-revision"
    candidate = cache / "candidate"
    if candidate.exists():
        shutil.rmtree(candidate)
    candidate.mkdir()
    extract_sources(git(repository, "archive", revision, *FORMATS), candidate)
    # Do not downgrade the bootstrap to a release that cannot update itself.
    if not all((candidate / "scripts" / name).is_file()
               for name in ("update.py", "repair.py", "install.py")):
        return None
    if (marker.exists() and marker.read_text().strip() == revision
            and installed_sources_match(candidate, extensions_dir or default_extensions_dir())):
        return None
    return candidate / "scripts/install.py", revision
