#!/usr/bin/env python3
"""Build a self-contained macOS app for double-click installation."""

import argparse
import plistlib
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "Sweetiebot Installer.app"


def build(destination: Path) -> None:
    destination = destination.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as staging:
        app = Path(staging) / APP_NAME
        subprocess.run(
            ["osacompile", "-o", str(app), str(ROOT / "assets/installer.applescript")],
            check=True,
        )
        payload = app / "Contents/Resources/toolkit"
        # Bundle only known installer source formats, never local configuration.
        for directory, suffixes in (
            ("scripts", {".py", ".json"}),
            ("assets/workbench", {".js", ".css"}),
            ("assets/codex", {".js", ".css"}),
            ("efs", {".js", ".json", ".svg", ".md"}),
        ):
            for source in (ROOT / directory).rglob("*"):
                if source.is_file() and source.suffix in suffixes:
                    target = payload / directory / source.relative_to(ROOT / directory)
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
        )
        with info_path.open("wb") as stream:
            plistlib.dump(info, stream)
        subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
        if destination.exists():
            if not destination.is_dir() or destination.suffix != ".app":
                raise ValueError(f"Refusing to replace non-app destination: {destination}")
            shutil.rmtree(destination)
        shutil.move(str(app), str(destination))
    print(f"Built {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / APP_NAME)
    build(parser.parse_args().output)
