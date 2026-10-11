#!/usr/bin/env python3
"""Serialize automatic app repairs across VS Code windows on macOS."""

import fcntl
import os
import sys
import subprocess
import tarfile
from pathlib import Path
from update import prepare_update

RETRY_LATER = 75

def repair(arguments, *, install=False):
    lock_dir = Path.home() / 'Library/Caches/dev.ponyfactor.sweetiebot'
    lock_dir.mkdir(parents=True, exist_ok=True)
    with (lock_dir / 'repair.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | (0 if install else fcntl.LOCK_NB))
        except BlockingIOError:
            print('Another window is updating Sweetie Bot; retrying before offering a reload.', flush=True)
            return RETRY_LATER
        try:
            update = prepare_update(lock_dir, force=True) if install else prepare_update(lock_dir)
        except (OSError, subprocess.SubprocessError, ValueError, tarfile.TarError) as error:
            print(f"Toolkit update check unavailable ({type(error).__name__}); repairing installed sources.", flush=True)
            update = None
        for attempt in range(3):
            if not update:
                break
            installer, revision = update
            result = subprocess.run([sys.executable, str(installer), *arguments])
            if result.returncode == 0:
                (lock_dir / 'installed-revision').write_text(revision + '\n')
                try:
                    update = prepare_update(lock_dir)
                except (OSError, subprocess.SubprocessError, ValueError, tarfile.TarError):
                    return 0
                if not update:
                    return 0
                continue
            # A fetched release failed to apply. Running the older bundled
            # installer here can silently undo a newer partial repair.
            print('Toolkit update could not be installed; keeping the fetched release for retry.', flush=True)
            return result.returncode
        else:
            print('Published sources are still changing; retrying before offering a reload.', flush=True)
            return RETRY_LATER
        # Exec retains the lock until the installer exits, including if the host
        # terminates the repair on shutdown or timeout.
        os.set_inheritable(lock.fileno(), True)
        os.execv(sys.executable, [sys.executable,
            str(Path(__file__).with_name('install.py')), *([] if install else ['--repair']), *arguments])


if __name__ == '__main__':
    arguments = sys.argv[1:]
    install = '--install' in arguments
    if install:
        arguments.remove('--install')
    raise SystemExit(repair(arguments, install=install))
