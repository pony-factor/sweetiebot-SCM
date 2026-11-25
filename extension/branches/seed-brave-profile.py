"""Opt-in, local-only Brave cookie-store seeding for a fresh test profile."""

from contextlib import closing
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
    result = subprocess.run(["/usr/bin/pgrep", "-f", pattern], capture_output=True)
    if result.returncode not in (0, 1):
        raise RuntimeError("Could not verify the test browser is stopped.")
    return result.returncode == 0


if __name__ == "__main__":
    normal = Path.home() / "Library/Application Support/BraveSoftware/Brave-Browser/Default"
    seed(normal, sys.argv[1], browser_running)
