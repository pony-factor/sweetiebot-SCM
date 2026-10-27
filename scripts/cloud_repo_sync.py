#!/usr/bin/env python3
"""Fast-forward recently active local main checkouts every fifteen minutes."""
import argparse
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys

LABEL = "dev.ponyfactor.sweetiebot-cloud-repos"
FLAG = "scm-toolkit.cloud-repository-sync"
STATE = Path.home() / "Library/Application Support/Sweetiebot/Repository Sync"
REGISTRY = STATE / "repositories.json"
ROOTS = (Path.home() / "GitHub",
         Path.home() / "Library/Application Support/Sweetiebot/Workspaces")
AGENT = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
INTERVAL = 15 * 60


def register(paths):
    """Remember local workspace roots so closing VS Code does not lose them."""
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "registry.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        known = set(json.loads(REGISTRY.read_text())) if REGISTRY.exists() else set()
        for path in paths:
            result = git(path, "rev-parse", "--show-toplevel", check=False)
            if result.returncode == 0:
                known.add(result.stdout.strip())
        temporary = REGISTRY.with_suffix(".tmp")
        temporary.write_text(json.dumps(sorted(known)) + "\n")
        temporary.replace(REGISTRY)


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
    """Find existing checkouts; never clone or inspect working-file contents."""
    seen = set()
    paths = json.loads(REGISTRY.read_text()) if REGISTRY.exists() else []
    for root in ROOTS:
        if root.is_symlink():
            continue
        for directory, dirs, files in os.walk(root, followlinks=False):
            if ".git" in dirs or ".git" in files:
                paths.append(directory)
                dirs[:] = []
            else:
                dirs[:] = [name for name in dirs if not name.startswith(".")
                           and name not in ("node_modules", "vendor", "build", "dist")]
    for location in paths:
        path = Path(location)
        if not path.is_dir() or path.is_symlink():
            continue
        canonical = path.resolve()
        if canonical not in seen:
            seen.add(canonical)
            yield path


def clean(path):
    r = git(path, "status", "--porcelain=v1", "--untracked-files=all", check=False)
    return r.returncode == 0 and not r.stdout.strip()


def pending(path):
    return any(Path(git(path, "rev-parse", "--path-format=absolute", "--git-path", name)
                    .stdout.strip()).exists() for name in (
        "sweetiebot-background-commit.json", "sweetiebot-async-commit.json",
        "sweetiebot-background-finalization.json", "MERGE_HEAD", "rebase-merge",
        "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "index.lock"))


def branch(path):
    return git(path, "symbolic-ref", "--quiet", "--short", "HEAD", check=False).stdout.strip()


def update(path):
    if path.is_symlink() or (path / ".git").is_symlink():
        return "unsafe"
    if branch(path) != "main":
        return "other-branch"
    if not clean(path):
        return "local-changes"
    # Use the configured main upstream, including remotes other than origin.
    remote = git(path, "config", "--get", "branch.main.remote", check=False).stdout.strip()
    upstream = git(path, "config", "--get", "branch.main.merge", check=False).stdout.strip()
    if not remote or remote == "." or upstream != "rextension/heads/main":
        return "no-main-upstream"
    with ExitStack() as locks:
        for name in ("sweetiebot-background-commit.json.lock", "sweetiebot-async-commit.lock"):
            filename = git(path, "rev-parse", "--path-format=absolute", "--git-path", name).stdout.strip()
            lock = locks.enter_context(Path(filename).open("a+b"))
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return "busy"
        if pending(path):
            return "pending-commit"
        head = git(path, "rev-parse", "--verify", "HEAD", check=False)
        if head.returncode:
            return "no-main-commit"
        local = head.stdout.strip()
        # FETCH_HEAD is deliberately not written: other Git operations may use it.
        target = "rextension/remotes/" + remote + "/main"
        fetched = git(path, "fetch", "--no-tags", "--no-write-fetch-head", "--", remote,
                      "+rextension/heads/main:" + target, check=False)
        if fetched.returncode:
            if "couldn't find remote ref" in fetched.stderr.lower():
                return "no-remote-main"
            raise RuntimeError("Unable to fetch upstream main without prompts")
        remote_sha = git(path, "rev-parse", target).stdout.strip()
        if not git(path, "log", "-1", "--since=7 days ago", "--format=%H", remote_sha).stdout.strip():
            return "inactive"
        if branch(path) != "main" or git(path, "rev-parse", "HEAD").stdout.strip() != local:
            return "branch-changed"
        if (git(path, "config", "--get", "branch.main.remote", check=False).stdout.strip() != remote
                or git(path, "config", "--get", "branch.main.merge", check=False).stdout.strip() != upstream):
            return "upstream-changed"
        if not clean(path):
            return "local-changes"
        if pending(path):
            return "pending-commit"
        if local == remote_sha:
            return "current"
        if git(path, "merge-base", "--is-ancestor", local, remote_sha, check=False).returncode:
            return "diverged"
        git(path, "merge", "--ff-only", "--", remote_sha)
        return "updated"


def run():
    if not enabled():
        return
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / ".sync.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        counts = {}
        paths = list(discover())
        print(f"Sweetiebot repository sync: checking {len(paths)} existing checkouts", flush=True)
        for path in paths:
            try:
                result = update(path)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                result = "failed"
            counts[result] = counts.get(result, 0) + 1
            if result in ("updated", "failed"):
                print(f"Sweetiebot repository sync: {result}: {path}", flush=True)
        print("Sweetiebot repository sync:", json.dumps(counts, sort_keys=True), flush=True)


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
        "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"},
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
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--install", action="store_true")
    mode.add_argument("--uninstall", action="store_true")
    mode.add_argument("--run", action="store_true")
    parser.add_argument("--register", nargs="*", default=[])
    args = parser.parse_args()
    if args.register:
        register(args.register)
    if args.install:
        configure(True)
    elif args.uninstall:
        configure(False)
    elif args.run:
        run()
