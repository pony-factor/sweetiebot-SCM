#!/usr/bin/env python3
"""Install a separate macOS Ollama worker for interactive commit requests."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time
import urllib.request

LABEL = "dev.ponyfactor.sweetiebot-ollama"
URL = "http://127.0.0.1:11435"
CONFIG_KEY = "scm-toolkit.ai-ollama-url"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def service_definition(binary: str, home: Path) -> dict:
    return {
        "Label": LABEL,
        "ProgramArguments": [binary, "serve"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "EnvironmentVariables": {
            "HOME": str(home),
            "OLLAMA_HOST": "127.0.0.1:11435",
            "OLLAMA_MODELS": str(home / ".ollama/models"),
            "OLLAMA_MAX_LOADED_MODELS": "1",
            "OLLAMA_NUM_PARALLEL": "1",
            "OLLAMA_CONTEXT_LENGTH": "4096",
            "OLLAMA_FLASH_ATTENTION": "1",
            "OLLAMA_KV_CACHE_TYPE": "q8_0",
            "OLLAMA_NO_CLOUD": "1",
        },
        # Do not persist prompts or inherited environment values in logs.
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": "/dev/null",
    }


def ready() -> bool:
    try:
        with OPENER.open(URL + "/api/version", timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def install(home: Path | None = None, binary: str | None = None) -> None:
    if sys.platform != "darwin":
        raise RuntimeError("The dedicated worker installer currently supports macOS.")
    home = home or Path.home()
    binary = binary or shutil.which("ollama")
    if not binary:
        raise RuntimeError("Install Ollama before configuring the commit worker.")
    agent = home / "Library/LaunchAgents" / (LABEL + ".plist")
    service = f"gui/{os.getuid()}/{LABEL}"
    registered = subprocess.run(
        ["/bin/launchctl", "print", service], capture_output=True, check=False,
    ).returncode == 0
    if not registered:
        if ready():
            raise RuntimeError("Port 11435 is already in use; refusing to replace its service.")
        if agent.is_symlink():
            raise RuntimeError("Refusing to replace a symlinked LaunchAgent.")
        agent.parent.mkdir(parents=True, exist_ok=True)
        agent.write_bytes(plistlib.dumps(service_definition(binary, home)))
        agent.chmod(0o600)
        subprocess.run(
            ["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(agent)],
            check=True, capture_output=True,
        )
    # Never restart the shared OCR service or an already registered worker.
    for _ in range(30):
        if ready():
            subprocess.run(
                ["/usr/bin/git", "config", "--global", CONFIG_KEY, URL], check=True,
            )
            print(f"Commit generation uses {URL}; OCR keeps its existing Ollama service.")
            return
        time.sleep(0.5)
    raise RuntimeError("The dedicated commit worker did not start; the commit endpoint was not changed.")


def uninstall() -> None:
    service = f"gui/{os.getuid()}/{LABEL}"
    subprocess.run(["/bin/launchctl", "bootout", service], check=False, capture_output=True)
    agent = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
    if agent.is_symlink():
        raise RuntimeError("Refusing to remove a symlinked LaunchAgent.")
    agent.unlink(missing_ok=True)
    value = subprocess.run(
        ["/usr/bin/git", "config", "--global", "--get", CONFIG_KEY],
        capture_output=True, text=True, check=False,
    ).stdout.strip()
    if value == URL:
        subprocess.run(["/usr/bin/git", "config", "--global", "--unset", CONFIG_KEY], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    if args.uninstall:
        uninstall()
    else:
        install()
