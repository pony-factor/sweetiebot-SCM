#!/usr/bin/env python3
"""Opt-in eight-hour GitHub main mirror; never alters an existing user workspace."""
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys

LABEL = "dev.ponyfactor.sweetiebot-cloud-repos"
FLAG = "scm-toolkit.cloud-repository-sync"
HOME = Path(os.environ.get("SWEETIEBOT_CLOUD_REPOS",
    "~/Library/Application Support/Sweetiebot/Cloud Repositories")).expanduser()
AGENT = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
INTERVAL = 8 * 60 * 60
VALID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def command(*args, check=True):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GH_PROMPT_DISABLED="1",
               GCM_INTERACTIVE="never")
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=180)
    if check and result.returncode:
        raise RuntimeError("GitHub or Git operation failed (no force update attempted)")
    return result


def git(path, *args, check=True):
    return command("git", "-C", str(path), *args, check=check)


def enabled():
    r = command("git", "config", "--global", "--bool", "--get", FLAG, check=False)
    return r.returncode == 0 and r.stdout.strip() == "true"


def discover():
    response = command("gh", "api", "--paginate", "--slurp",
        "user/repos?affiliation=owner,collaborator,organization_member&per_page=100")
    for page in json.loads(response.stdout):
        for entry in page:
            if not isinstance(entry, dict) or entry.get("archived") or entry.get("disabled"):
                continue
            if entry.get("default_branch") != "main":
                continue
            pair = str(entry.get("full_name", "")).split("/")
            if len(pair) == 2 and all(VALID.fullmatch(p) and p not in (".", "..") for p in pair):
                yield pair


def clean(path):
    r = git(path, "status", "--porcelain=v1", "--untracked-files=all", check=False)
    return r.returncode == 0 and not r.stdout.strip()


def update(path, url):
    if path.is_symlink() or (path / ".git").is_symlink():
        return "unsafe"
    marker = path / ".git" / "sweetiebot-cloud-mirror"
    if not marker.is_file():
        return "unmanaged"
    remote = git(path, "remote", "get-url", "origin", check=False)
    if remote.returncode or remote.stdout.strip().removesuffix(".git") != url:
        return "foreign-origin"
    branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
    if branch.returncode or branch.stdout.strip() != "main":
        return "other-branch"
    if not clean(path):
        return "local-changes"
    if any((path / ".git" / name).exists() for name in
           ("sweetiebot-background-commit.json", "sweetiebot-async-commit.json")):
        return "pending-commit"
    git(path, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
    if not clean(path):
        return "local-changes"
    local = git(path, "rev-parse", "refs/heads/main").stdout.strip()
    remote_sha = git(path, "rev-parse", "refs/remotes/origin/main").stdout.strip()
    if local == remote_sha:
        return "current"
    if git(path, "merge-base", "--is-ancestor", local, remote_sha, check=False).returncode:
        return "diverged"
    git(path, "merge", "--ff-only", "refs/remotes/origin/main")
    return "updated"


def sync_repo(owner, name):
    parent = HOME / owner
    repo = parent / name
    if HOME.is_symlink() or parent.is_symlink() or repo.is_symlink():
        return "unsafe"
    url = "https://github.com/" + owner + "/" + name
    if repo.exists():
        return update(repo, url)
    parent.mkdir(parents=True, exist_ok=True)
    if repo.exists():
        return "unmanaged"
    try:
        git(parent, "clone", "--single-branch", "--branch", "main", "--no-tags",
            url + ".git", str(repo))
        (repo / ".git" / "sweetiebot-cloud-mirror").write_text(url + "\n")
        return "cloned"
    except (OSError, RuntimeError, subprocess.SubprocessError):
        # Leave partial clones for human inspection rather than removing files.
        return "clone-failed"


def run():
    if not enabled():
        return
    if HOME.is_symlink():
        raise RuntimeError("Refusing a symlinked mirror root")
    HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (HOME / ".sync.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        counts = {}
        for owner, name in discover():
            try:
                result = sync_repo(owner, name)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                result = "failed"
            counts[result] = counts.get(result, 0) + 1
        print("Sweetiebot main mirror:", json.dumps(counts, sort_keys=True), flush=True)


def configure(on):
    command("git", "config", "--global", FLAG, "true" if on else "false")
    if sys.platform != "darwin":
        return
    if AGENT.is_symlink():
        raise RuntimeError("Refusing a symlinked LaunchAgent")
    service = "gui/" + str(os.getuid()) + "/" + LABEL
    loaded = command("/bin/launchctl", "print", service, check=False).returncode == 0
    if not on:
        if loaded:
            command("/bin/launchctl", "bootout", service, check=False)
        AGENT.unlink(missing_ok=True)
        return
    logs = Path.home() / "Library/Logs/Sweetiebot"
    logs.mkdir(parents=True, exist_ok=True)
    configuration = {"Label": LABEL,
        "ProgramArguments": [sys.executable, str(Path(__file__).resolve()), "--run"],
        "RunAtLoad": True, "StartInterval": INTERVAL,
        "StandardOutPath": str(logs / "cloud-repository-sync.log"),
        "StandardErrorPath": str(logs / "cloud-repository-sync-errors.log")}
    payload = plistlib.dumps(configuration)
    AGENT.parent.mkdir(parents=True, exist_ok=True)
    if loaded and AGENT.is_file() and AGENT.read_bytes() == payload:
        return
    if loaded:
        command("/bin/launchctl", "bootout", service, check=False)
    AGENT.write_bytes(payload)
    AGENT.chmod(0o600)
    command("/bin/launchctl", "bootstrap", "gui/" + str(os.getuid()), str(AGENT))


if __name__ == "__main__":
    if sys.argv[1:] == ["--install"]:
        configure(True)
    elif sys.argv[1:] == ["--uninstall"]:
        configure(False)
    elif sys.argv[1:] == ["--run"]:
        run()
    else:
        raise SystemExit("Usage: cloud_repo_sync.py --install|--uninstall|--run")
