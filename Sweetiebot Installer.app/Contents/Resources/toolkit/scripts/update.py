"""Fetch published toolkit sources in an isolated cache for automatic repair."""

from __future__ import annotations

import io
import shutil
import subprocess
import tarfile
from pathlib import Path

REMOTE = "https://github.com/pony-factor/sweetiebot-SCM.git"
FORMATS = {
    "scripts": {".py", ".json"},
    "efs": {".js", ".json", ".svg", ".md"},
    "assets/workbench": {".js", ".css"},
    "assets/codex": {".js", ".css"},
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


def prepare_update(cache):
    repository = cache / "upstream.git"
    if not repository.exists():
        repository.mkdir(parents=True)
        git(repository, "init", "--bare")
    git(repository, "fetch", "--depth=1", "--no-tags", REMOTE, "refs/heads/main")
    revision = git(repository, "rev-parse", "FETCH_HEAD").decode().strip()
    marker = cache / "installed-revision"
    if marker.exists() and marker.read_text().strip() == revision:
        return None
    candidate = cache / "candidate"
    if candidate.exists():
        shutil.rmtree(candidate)
    candidate.mkdir()
    extract_sources(git(repository, "archive", revision, *FORMATS), candidate)
    # Do not downgrade the bootstrap to a release that cannot update itself.
    if not all((candidate / "scripts" / name).is_file()
               for name in ("update.py", "repair.py", "install.py")):
        return None
    return candidate / "scripts/install.py", revision
