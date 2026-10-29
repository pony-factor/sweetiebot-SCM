#!/bin/sh
set -eu
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Core ML bridge requires macOS 15+." >&2
  exit 1
fi
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
swift build --package-path "$here" -c release --product sweetiebot-ane
binary="$(swift build --package-path "$here" -c release --show-bin-path)/sweetiebot-ane"
target="$HOME/Library/Application Support/Sweetiebot/ANE"
mkdir -p "$target"
cp "$binary" "$target/sweetiebot-ane"
chmod 755 "$target/sweetiebot-ane"
printf 'Installed %s\n' "$target/sweetiebot-ane"
