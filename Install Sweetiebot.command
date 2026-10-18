#!/bin/bash
# Rebuild Sweetiebot's signed installer from the canonical source checkout.
set -euo pipefail
cd -- "$(dirname -- "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to build Sweetiebot. Install it, then try again." >&2
  exit 1
fi

if ! python3 scripts/build_installer_app.py; then
  echo "Could not build Sweetiebot's signed installer. Check the signing certificate instructions in README.md." >&2
  exit 1
fi

open "$PWD/Sweetiebot Installer.app"
