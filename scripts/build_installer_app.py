#!/usr/bin/env python3
"""Build a self-contained macOS app for double-click installation."""

import argparse
import hashlib
import os
import plistlib
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "Sweetiebot Installer.app"
SIGNING_IDENTITY = "Sweetiebot Installer Local Signing"
FORMATS = (
    ("scripts", {".py", ".json"}),
    ("assets/workbench", {".js", ".css"}),
    ("assets/codex", {".js", ".css"}),
    ("assets/browser", {".js"}),
    ("efs", {".js", ".json", ".svg", ".md"}),
)


def source_files():
    files = {Path("assets/commit-instructions.md"): ROOT / "assets/commit-instructions.md"}
    for directory, suffixes in FORMATS:
        for source in (ROOT / directory).rglob("*"):
            if source.is_file() and source.suffix in suffixes:
                files[source.relative_to(ROOT)] = source
    return dict(sorted(files.items()))


def source_digest(files):
    digest = hashlib.sha256()
    for relative, source in [(Path("assets/installer.applescript"), ROOT / "assets/installer.applescript"), *files.items()]:
        data = source.read_bytes()
        digest.update(str(relative).encode() + b"\0")
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def up_to_date(destination, files, digest, fingerprint):
    try:
        with (destination / "Contents/Info.plist").open("rb") as stream:
            info = plistlib.load(stream)
        if info.get("SweetiebotSourceDigest") != digest or info.get("SweetiebotSigningIdentity") != fingerprint:
            return False
        payload = destination / "Contents/Resources/toolkit"
        actual = {path.relative_to(payload) for path in payload.rglob("*") if path.is_file()}
        if actual != set(files) or any((payload / relative).read_bytes() != source.read_bytes()
                                      for relative, source in files.items()):
            return False
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(destination)],
                       check=True, capture_output=True)
        return True
    except (OSError, ValueError, plistlib.InvalidFileException, subprocess.SubprocessError):
        return False


def signing_identity(name: str) -> str:
    """Resolve one persistent Keychain identity; never fall back to ad hoc signing."""
    if not name.strip() or name == "-":
        raise ValueError("A persistent code-signing identity is required.")
    result = subprocess.run(
        ["security", "find-identity", "-v", "-p", "codesigning"],
        check=True, capture_output=True, text=True,
    )
    matches = [
        fingerprint for fingerprint, label in re.findall(
            r'\b([0-9A-Fa-f]{40}) "([^"]+)"', result.stdout
        ) if name == label or name.upper() == fingerprint.upper()
    ]
    if len(matches) != 1:
        raise ValueError(
            f"Expected one valid Keychain signing identity for {name!r}, found {len(matches)}. "
            "Create a Code Signing certificate in Keychain Access, or select an existing "
            "identity with --signing-identity. Keep using the same certificate for rebuilds."
        )
    return matches[0]


def build(destination: Path, identity: str = SIGNING_IDENTITY) -> None:
    fingerprint = signing_identity(identity)
    destination = destination.expanduser().resolve()
    files = source_files()
    digest = source_digest(files)
    if up_to_date(destination, files, digest, fingerprint):
        print(f"Already up to date: {destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as staging:
        app = Path(staging) / APP_NAME
        subprocess.run(
            ["osacompile", "-o", str(app), str(ROOT / "assets/installer.applescript")],
            check=True,
        )
        payload = app / "Contents/Resources/toolkit"
        (payload / "assets").mkdir(parents=True, exist_ok=True)
        # Bundle only known installer source formats, never local configuration.
        for relative, source in files.items():
            target = payload / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        info_path = app / "Contents/Info.plist"
        with info_path.open("rb") as stream:
            info = plistlib.load(stream)
        info.update(
            CFBundleIdentifier="dev.ponyfactor.sweetiebot-installer",
            CFBundleName="Sweetiebot Installer",
            CFBundleDisplayName="Sweetiebot Installer",
            CFBundleShortVersionString="1.0",
            CFBundleVersion="1",
            SweetiebotSourceDigest=digest,
            SweetiebotSigningIdentity=fingerprint,
        )
        with info_path.open("wb") as stream:
            plistlib.dump(info, stream)
        subprocess.run(
            ["codesign", "--force", "--sign", fingerprint, "--timestamp=none", str(app)],
            check=True,
        )
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        if destination.exists():
            if not destination.is_dir() or destination.suffix != ".app":
                raise ValueError(f"Refusing to replace non-app destination: {destination}")
            shutil.rmtree(destination)
        shutil.move(str(app), str(destination))
    print(f"Built {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / APP_NAME)
    parser.add_argument(
        "--signing-identity",
        default=os.environ.get("SWEETIEBOT_SIGNING_IDENTITY", SIGNING_IDENTITY),
        help="Persistent Keychain certificate name or SHA-1 fingerprint",
    )
    args = parser.parse_args()
    build(args.output, args.signing_identity)
