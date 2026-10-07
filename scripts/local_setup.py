#!/usr/bin/env python3
"""Local Sweetiebot instruction and Git-signing setup helpers."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


def commit_instructions_path() -> Path:
    configured = os.environ.get(
        "SCM_TOOLKIT_COMMIT_INSTRUCTIONS",
        "~/.config/sweetiebot/commit-instructions.md",
    )
    return Path(configured).expanduser()


def load_commit_instructions() -> str:
    path = commit_instructions_path()
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    except (OSError, UnicodeError) as error:
        raise RuntimeError(f"Unable to read Sweetiebot commit instructions: {error}") from error


def save_commit_instructions(instructions: str) -> Path:
    path = commit_instructions_path()
    if path.is_symlink():
        raise RuntimeError(f"Refusing to replace symlinked commit instructions: {path}")

    text = str(instructions or "").replace("\r\n", "\n").replace("\r", "\n")
    if text and not text.endswith("\n"):
        text += "\n"

    try:
        current = path.read_text(encoding="utf-8") if path.exists() else None
    except (OSError, UnicodeError) as error:
        raise RuntimeError(f"Unable to read Sweetiebot commit instructions: {error}") from error
    if current == text:
        return path

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, path)
    except OSError as error:
        raise RuntimeError(f"Unable to save Sweetiebot commit instructions: {error}") from error
    return path


def _git_value(key: str) -> str:
    git = shutil.which("git")
    if not git:
        return ""
    result = subprocess.run(
        [git, "config", "--global", "--get", key],
        capture_output=True,
        text=True,
        cwd=Path.home(),
    )
    if result.returncode == 1:
        return ""
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"Unable to read Git setting {key}.")
    return result.stdout.strip()


def _decode_uid(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        try:
            return bytes([int(match.group(1), 16)]).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return match.group(0)

    return re.sub(r"\\x([0-9A-Fa-f]{2})", replace, value)


def list_signing_keys() -> list[dict[str, str]]:
    gpg = shutil.which("gpg")
    if not gpg:
        return []

    result = subprocess.run(
        [gpg, "--batch", "--with-colons", "--fingerprint", "--list-secret-keys"],
        capture_output=True,
        text=True,
    )
    if result.returncode not in (0, 2):
        raise RuntimeError(result.stderr.strip() or "Unable to inspect local OpenPGP keys.")

    keys: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in result.stdout.splitlines():
        fields = line.split(":")
        kind = fields[0] if fields else ""
        if kind == "sec":
            current = {"fingerprint": "", "uid": ""}
            continue
        if current is None:
            continue
        if kind == "fpr" and not current["fingerprint"] and len(fields) > 9:
            current["fingerprint"] = fields[9].upper()
            keys.append(current)
            continue
        if kind == "uid" and not current["uid"] and len(fields) > 9:
            current["uid"] = _decode_uid(fields[9])
    return [key for key in keys if key["fingerprint"]]


def configured_signing_key() -> str:
    return _git_value("user.signingkey").upper()


def signing_status() -> dict[str, object]:
    keys = list_signing_keys()
    return {
        "gpgAvailable": bool(shutil.which("gpg")),
        "configured": configured_signing_key(),
        "keys": keys,
        "instructionsPath": str(commit_instructions_path()),
    }


def configure_signing_key(fingerprint: str) -> str:
    normalized = re.sub(r"\s+", "", str(fingerprint or "")).upper()
    if not re.fullmatch(r"[0-9A-F]{16,64}", normalized):
        raise ValueError("Choose a valid local OpenPGP signing-key fingerprint.")

    available = {key["fingerprint"].upper() for key in list_signing_keys()}
    if normalized not in available:
        raise ValueError("That OpenPGP secret key is not available in the local key store.")

    git = shutil.which("git")
    if not git:
        raise RuntimeError("Git was not found on PATH.")

    for key, value in (
        ("user.signingkey", normalized),
        ("commit.gpgsign", "true"),
        ("gpg.format", "openpgp"),
    ):
        result = subprocess.run(
            [git, "config", "--global", "--replace-all", key, value],
            capture_output=True,
            text=True,
            cwd=Path.home(),
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or f"Unable to configure {key}.")
    return normalized


def generate_signing_key() -> str:
    gpg = shutil.which("gpg")
    if not gpg:
        raise RuntimeError("GnuPG was not found on PATH. Install GnuPG before creating a signing key.")

    name = _git_value("user.name")
    email = _git_value("user.email")
    if not name or not email:
        raise RuntimeError("Set global Git user.name and user.email before creating a signing key.")

    before = {key["fingerprint"].upper() for key in list_signing_keys()}
    uid = f"{name} <{email}>"
    result = subprocess.run(
        [gpg, "--quick-generate-key", uid, "ed25519", "sign", "0"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip()
            or "GnuPG could not create the signing key. Complete the secure pinentry prompt and try again."
        )

    after = list_signing_keys()
    created = [key["fingerprint"].upper() for key in after if key["fingerprint"].upper() not in before]
    if not created:
        created = [
            key["fingerprint"].upper()
            for key in after
            if uid.lower() in str(key.get("uid") or "").lower()
        ]
    if not created:
        raise RuntimeError("The key was created, but Sweetiebot could not identify its fingerprint.")
    return configure_signing_key(created[-1])


def open_signing_key_manager() -> str:
    candidates: list[tuple[list[str], str]] = []
    if sys.platform == "darwin":
        candidates.append((["/usr/bin/open", "-a", "GPG Keychain"], "GPG Keychain"))
    elif os.name == "nt":
        kleopatra = shutil.which("kleopatra.exe") or shutil.which("kleopatra")
        if kleopatra:
            candidates.append(([kleopatra], "Kleopatra"))
    else:
        for executable, label in (("seahorse", "Passwords and Keys"), ("kleopatra", "Kleopatra")):
            path = shutil.which(executable)
            if path:
                candidates.append(([path], label))

    for command, label in candidates:
        try:
            result = subprocess.run(command, capture_output=True, text=True)
        except OSError:
            continue
        if result.returncode == 0:
            return label

    if sys.platform == "darwin":
        raise RuntimeError("GPG Keychain was not found. Install GPG Suite or manage the key with your preferred local OpenPGP tool.")
    if os.name == "nt":
        raise RuntimeError("Kleopatra was not found. Install Gpg4win or manage the key with your preferred local OpenPGP tool.")
    raise RuntimeError("No supported OpenPGP key manager was found. Install Seahorse or Kleopatra, or use your preferred local OpenPGP tool.")
