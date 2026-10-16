"""Fetch published toolkit sources in an isolated cache for automatic repair."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path
from workspace_search import default_extensions_dir, source_files

REMOTE = "https://github.com/pony-factor/sweetiebot-SCM.git"
FORMATS = {
    "scripts": {".py", ".json"},
    "efs": {".js", ".json", ".svg", ".md"},
    "assets/workbench": {".js", ".css"},
    "assets/codex": {".js", ".css"},
    "assets/browser": {".js"},
    "assets/github": {".js"},
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
    """Verify bundled sources and the files actually executed by VS Code/Git."""
    package = json.loads((candidate / "efs/package.json").read_text())
    destination = extensions_dir / f'{package["publisher"]}.{package["name"]}-{package["version"]}'
    for relative, source in source_files(candidate).items():
        if not source.is_file():
            continue
        target = destination / relative
        # The installer renders this manifest with user-selected view labels
        # and configuration defaults; source bytes are intentionally different.
        if relative == Path("package.json"):
            if target.is_symlink() or not target.is_file():
                return False
            try:
                installed = json.loads(target.read_text())
            except (OSError, ValueError):
                return False
            if any(installed.get(key) != package.get(key) for key in ("publisher", "name", "version", "main")):
                return False
            continue
        if target.is_symlink() or not target.is_file() or target.read_bytes() != source.read_bytes():
            return False
    wrapper = Path(os.environ.get("SCM_TOOLKIT_AI_WRAPPER_PATH", "~/.local/bin/scm-toolkit-git")).expanduser()
    for name, target in (
        ("ai_commit.py", wrapper),
        ("sweetiebot_diagnostics.py", wrapper.with_name("sweetiebot_diagnostics.py")),
        ("post_commit_spellcheck.py", wrapper.with_name(wrapper.name + "-spellcheck.py")),
    ):
        source = candidate / "scripts" / name
        if source.is_file() and (target.is_symlink() or not target.is_file()
                or (name != "sweetiebot_diagnostics.py" and not os.access(target, os.X_OK))
                or target.read_bytes() != source.read_bytes()):
            return False
    legacy = Path.home() / ".local/bin/git-auto-title"
    if (candidate / "scripts/ai_commit.py").is_file() and legacy != wrapper and (legacy.exists() or legacy.is_symlink()):
        for alias, target in ((legacy, wrapper), (legacy.with_name(legacy.name + "-spellcheck.py"), wrapper.with_name(wrapper.name + "-spellcheck.py"))):
            if not alias.is_symlink() or alias.resolve() != target.resolve():
                return False
    return True


def prepare_update(cache, extensions_dir=None, *, force=False):
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
    if (not force and marker.exists() and marker.read_text().strip() == revision
            and installed_sources_match(candidate, extensions_dir or default_extensions_dir())):
        return None
    return candidate / "scripts/install.py", revision
