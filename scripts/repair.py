#!/usr/bin/env python3
"""Serialize automatic app repairs across VS Code windows on macOS."""

import fcntl
import os
import sys
from pathlib import Path


def repair(arguments):
    lock_dir = Path.home() / 'Library/Caches/dev.ponyfactor.sweetiebot'
    lock_dir.mkdir(parents=True, exist_ok=True)
    with (lock_dir / 'repair.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        # Exec retains the lock until the installer exits, including if the host
        # terminates the repair on shutdown or timeout.
        os.set_inheritable(lock.fileno(), True)
        os.execv(sys.executable, [sys.executable,
            str(Path(__file__).with_name('install.py')), '--repair', *arguments])


if __name__ == '__main__':
    raise SystemExit(repair(sys.argv[1:]))
