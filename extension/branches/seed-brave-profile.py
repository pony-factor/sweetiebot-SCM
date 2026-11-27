"""Launch a repository's isolated Brave profile, with optional cookie seeding."""

from contextlib import closing
import fcntl
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import time


COOKIE_PATHS = ("Network/Cookies", "Cookies")


def seed(source_profile, target_root, running):
    source_profile = Path(source_profile).resolve()
    target_root = Path(target_root).resolve()
    target_profile = target_root / "Default"
    if source_profile == target_profile or source_profile.is_relative_to(target_root):
        raise ValueError("Source and test profile must be separate.")
    target_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Serialize cooperating launchers across VS Code windows.
    lock = target_root / ".sweetiebot-cookie-seed.lock"
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    try:
        if running(target_root):
            return False
        for name in COOKIE_PATHS:
            target = target_profile / name
            if any(os.path.lexists(str(target) + suffix) for suffix in ("", "-wal", "-shm", "-journal")):
                return False
        source = next((source_profile / name for name in COOKIE_PATHS
                       if (source_profile / name).is_file()), None)
        if source is None:
            raise FileNotFoundError("Normal Brave cookie store unavailable.")
        target = target_profile / source.relative_to(source_profile)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not target.parent.resolve().is_relative_to(target_root):
            raise ValueError("Unsafe destination.")
        descriptor, temporary = tempfile.mkstemp(prefix=".seed-", dir=target.parent)
        os.close(descriptor)
        try:
            with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5)) as original:
                with closing(sqlite3.connect(temporary)) as snapshot:
                    deadline = time.monotonic() + 10

                    def progress(status, remaining, total):
                        if time.monotonic() >= deadline:
                            raise TimeoutError("Cookie snapshot timed out.")

                    original.backup(snapshot, pages=128, progress=progress, sleep=0.05)
            # No cookie rows are queried, decrypted, displayed or exported.
            # Never replace an existing destination, even if it appeared during backup.
            if running(target_root):
                return False
            if any(os.path.lexists(str(target_profile / name) + suffix)
                   for name in COOKIE_PATHS for suffix in ("", "-wal", "-shm", "-journal")):
                return False
            os.link(temporary, target)
            return True
        finally:
            Path(temporary).unlink(missing_ok=True)
    finally:
        lock.unlink(missing_ok=True)


def browser_running(root):
    # macOS pgrep uses POSIX ERE. Escape only ERE metacharacters.
    flag = "--user-data-dir=" + str(root)
    pattern = re.sub(r"([.\\^$*+?{}\[\]|()])", r"\\\1", flag) + r"([[:space:]]|$)"
    # The pattern starts with "--user-data-dir"; end option parsing first.
    result = subprocess.run(["/usr/bin/pgrep", "-f", "--", pattern], capture_output=True)
    if result.returncode not in (0, 1):
        raise RuntimeError("Could not verify the test browser is stopped.")
    return result.returncode == 0


def prepare_extension(root, extension, running):
    manifest = root / "manifest.json"
    try:
        current = (extension / "manifest.json").readlink()
    except FileNotFoundError:
        current = None
    if running:
        if current != manifest:
            raise RuntimeError("Quit this repository's test Brave before switching checkouts.")
        return

    # Keep the unpacked path and its derived extension ID stable across branches.
    # Link resources without copying checkout files or touching Git state.
    with tempfile.TemporaryDirectory(prefix=".extension-", dir=extension.parent) as workspace:
        staging = Path(workspace) / "next"
        staging.mkdir()
        for entry in root.iterdir():
            if not entry.name.startswith("."):
                (staging / entry.name).symlink_to(entry)
        if extension.exists():
            extension.rename(Path(workspace) / "previous")
        staging.rename(extension)


def launch(root, repository, url, source=None, *, running=browser_running, run=subprocess.run):
    root = Path(root).resolve(strict=True)
    repository = Path(repository).resolve()
    repository.mkdir(parents=True, exist_ok=True, mode=0o700)
    profile = repository / "profile"
    extension = repository / "extension"
    with (repository / ".launch.lock").open("ab") as lease:
        try:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("This repository's test Brave is already launching.") from None
        active = running(profile)
        prepare_extension(root, extension, active)
        if source is not None and not active:
            seed(source, profile, running)
        # Wait until the browser has claimed the profile before another window
        # can change the checkout behind its running extension.
        run(["/usr/bin/open", "-na", "Brave Browser", "--args",
             "--user-data-dir=" + str(profile), "--disable-extensions-except=" + str(extension),
             "--load-extension=" + str(extension), "--no-first-run", "--no-default-browser-check",
             "--new-window", url], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            if running(profile):
                return
            time.sleep(0.1)
        raise RuntimeError("Brave did not start with the repository's test profile.")


if __name__ == "__main__":
    normal = Path.home() / "Library/Application Support/BraveSoftware/Brave-Browser"
    if len(sys.argv) == 2:
        seed(normal / "Default", sys.argv[1], browser_running)
    else:
        root, repository, url, *profile = sys.argv[1:]
        source = None
        if profile:
            if len(profile) != 1 or not re.fullmatch(r"Default|Profile [1-9][0-9]*", profile[0]):
                raise SystemExit("Invalid normal Brave profile.")
            source = normal / profile[0]
        try:
            launch(root, repository, url, source)
        except RuntimeError as error:
            raise SystemExit(str(error)) from None
        except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
            raise SystemExit("Could not launch test Brave. Check the checkout and selected Brave profile.") from None
