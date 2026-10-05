#!/usr/bin/env python3
"""Local ChatGPT/Codex instruction mirroring and commit-signing helpers."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path


START = "<!-- scm-toolkit-chatgpt-instructions:start -->"
END = "<!-- scm-toolkit-chatgpt-instructions:end -->"
CODEX_WEB_COAUTHOR = "Co-authored-by: Codex Web <noreply@openai.com>"


def codex_agents_path() -> Path:
    root = Path(os.environ.get("SCM_TOOLKIT_CODEX_HOME", "~/.codex")).expanduser()
    return root / "AGENTS.md"


def managed_instruction_block(instructions: str, web_codex_coauthor: bool) -> str:
    parts = [START]
    text = str(instructions or "").strip()
    if text:
        parts.append(text)
    if web_codex_coauthor:
        if text:
            parts.append("")
        parts.extend(
            [
                "When creating Git commits through web or GitHub tools, append this trailer after a blank line:",
                CODEX_WEB_COAUTHOR,
            ]
        )
    parts.append(END)
    return "\n".join(parts)


def sync_codex_instructions(
    instructions: str,
    web_codex_coauthor: bool,
    *,
    destination: Path | None = None,
) -> Path:
    path = Path(destination) if destination is not None else codex_agents_path()
    existing = path.read_text() if path.exists() else ""
    pattern = re.compile(
        re.escape(START) + r".*?" + re.escape(END),
        flags=re.DOTALL,
    )
    stripped = pattern.sub("", existing).strip()
    include_block = bool(str(instructions or "").strip()) or bool(web_codex_coauthor)
    pieces = [piece for piece in (stripped, managed_instruction_block(instructions, web_codex_coauthor) if include_block else "") if piece]
    updated = "\n\n".join(pieces)
    if updated:
        updated += "\n"

    if updated == existing:
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(updated)
    return path


def _gpg_fingerprint(secret_key: str, gpg: str) -> str:
    result = subprocess.run(
        [gpg, "--batch", "--with-colons", "--import-options", "show-only", "--import"],
        input=secret_key,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Unable to inspect the PGP secret key.")

    saw_secret = False
    for line in result.stdout.splitlines():
        fields = line.split(":")
        if fields and fields[0] in {"sec", "ssb"}:
            saw_secret = True
            continue
        if saw_secret and fields and fields[0] == "fpr" and len(fields) > 9 and fields[9]:
            return fields[9]
    raise ValueError("The supplied PGP material did not contain a secret signing key.")


def import_pgp_secret_key(secret_key: str) -> str | None:
    secret = str(secret_key or "").strip()
    if not secret:
        return None

    gpg = shutil.which("gpg")
    git = shutil.which("git")
    if not gpg:
        raise RuntimeError("GnuPG was not found on PATH.")
    if not git:
        raise RuntimeError("Git was not found on PATH.")

    fingerprint = _gpg_fingerprint(secret, gpg)
    imported = subprocess.run(
        [gpg, "--batch", "--import"],
        input=secret,
        capture_output=True,
        text=True,
    )
    if imported.returncode != 0:
        raise RuntimeError(imported.stderr.strip() or "Unable to import the PGP secret key.")

    for key, value in (
        ("user.signingkey", fingerprint),
        ("commit.gpgsign", "true"),
        ("gpg.format", "openpgp"),
    ):
        result = subprocess.run(
            [git, "config", "--global", "--replace-all", key, value],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or f"Unable to configure {key}.")

    return fingerprint
