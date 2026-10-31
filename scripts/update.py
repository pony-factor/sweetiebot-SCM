"""Fetch published toolkit sources in an isolated cache for automatic repair."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from workspace_search import default_extensions_dir, source_files
from wrapper_dependencies import wrapper_files

REMOTE = "https://github.com/pony-factor/sweetiebot-SCM.git"
THINKING_ASSET = Path('assets/browser/maximize_thinking.js')
SHARED_PROFILE_SOURCE = Path('scripts/browser_pr.py')
SHARED_PROFILE_MARKER = 'SHARED_BROWSER_PROFILE = 2'
FORMATS = {
    "scripts": {".py", ".json"},
    "extension": {".js", ".json", ".svg", ".md", ".html"},
    "assets/workbench": {".js", ".css"},
    "assets/codex": {".js", ".css"},
    "assets/imgs": {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico"},
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
            if not any(relative.is_relative_to(folder) and relative.suffix.lower() in suffixes
                       for folder, suffixes in FORMATS.items()):
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with files.extractfile(member) as source:
                target.write_bytes(source.read())


def installed_sources_match(candidate, extensions_dir):
    """Verify bundled sources and the files actually executed by VS Code/Git."""
    package = json.loads((candidate / "extension/package.json").read_text())
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
    try:
        expected = wrapper_files(candidate / "scripts", wrapper)
    except (OSError, RuntimeError, SyntaxError):
        return False
    for target, source in expected.items():
        if (target.is_symlink() or not target.is_file() or
                not os.access(target, os.X_OK) or target.read_bytes() != source.read_bytes()):
            return False
    legacy = Path.home() / ".local/bin/git-auto-title"
    pony_source = candidate / "extension/commits/pony_git_publish.js"
    pony_target = wrapper.with_name("pony_git_publish.js")
    if pony_source.is_file() and (pony_target.is_symlink() or not pony_target.is_file()
            or pony_target.read_bytes() != pony_source.read_bytes()):
        return False
    if (candidate / "scripts/ai_commit.py").is_file() and legacy != wrapper and (legacy.exists() or legacy.is_symlink()):
        for alias, target in ((legacy, wrapper), (legacy.with_name(legacy.name + "-spellcheck.py"), wrapper.with_name(wrapper.name + "-spellcheck.py"))):
            if not alias.is_symlink() or alias.resolve() != target.resolve():
                return False
    return True


def installer_imports(candidate):
    """Check runtime compatibility before an installer can change the app."""
    result = subprocess.run(
        [sys.executable, "-B", "-c", "import install"],
        cwd=candidate / "scripts", capture_output=True, timeout=30,
    )
    return result.returncode == 0


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
    # Older releases load this HTML during extension activation but omit it
    # from update archives and bundled repair sources. Do not replace a working
    # bootstrap with one that will remove the asset on its next repair.
    if (candidate / "extension/codex/draft_handoff.js").is_file():
        packaging = (candidate / "scripts" / name for name in
                     ("update.py", "workspace_search.py"))
        if (not (candidate / "extension/ui/draft_confirmation.html").is_file()
                or any(not source.is_file() or '".html"' not in source.read_text()
                       for source in packaging)):
            print('Published release omits PR HTML from automatic repair; keeping the installed sources.', flush=True)
            return None
    # A locally installed PR preview can be ahead of published main. Retain
    # its pre-Send thinking guard until the release contains that capability;
    # an explicit installer update may still replace the preview.
    if (not force and (Path(__file__).resolve().parent.parent / THINKING_ASSET).is_file()
            and not (candidate / THINKING_ASSET).is_file()):
        print('Published release predates maximum thinking; keeping the installed preview.', flush=True)
        return None
    local_profile = Path(__file__).resolve().parent.parent / SHARED_PROFILE_SOURCE
    published_profile = candidate / SHARED_PROFILE_SOURCE
    if (not force and local_profile.is_file()
            and SHARED_PROFILE_MARKER in local_profile.read_text()
            and (not published_profile.is_file()
                 or SHARED_PROFILE_MARKER not in published_profile.read_text())):
        print('Published release predates shared browser sign-ins; keeping the installed preview.', flush=True)
        return None
    if not installer_imports(candidate):
        print('Published installer cannot load with this Python; keeping the installed sources.', flush=True)
        return None
    if (not force and marker.exists() and marker.read_text().strip() == revision
            and installed_sources_match(candidate, extensions_dir or default_extensions_dir())):
        return None
    return candidate / "scripts/install.py", revision
