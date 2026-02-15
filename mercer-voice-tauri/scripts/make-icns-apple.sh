#!/bin/bash
# Optional: build icon.icns with macOS iconutil (if your iconutil works).
# Prefer: ./scripts/apply-dock-icon.sh which uses Tauri's icon generator and copies into the built app.
set -e
ICONS_DIR="src-tauri/icons"
SRC="$ICONS_DIR/icon-1024-stripped.png"
ICONSET="$ICONS_DIR/icon.iconset"

if [[ ! -f "$SRC" ]]; then
  echo "Run first: node scripts/strip-icon-background.js"
  exit 1
fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"
sips -z 16 16   "$SRC" --out "$ICONSET/icon_16x16.png"
sips -z 32 32   "$SRC" --out "$ICONSET/icon_16x16@2x.png"
sips -z 32 32   "$SRC" --out "$ICONSET/icon_32x32.png"
sips -z 64 64   "$SRC" --out "$ICONSET/icon_32x32@2x.png"
sips -z 128 128 "$SRC" --out "$ICONSET/icon_128x128.png"
sips -z 256 256 "$SRC" --out "$ICONSET/icon_128x128@2x.png"
sips -z 256 256 "$SRC" --out "$ICONSET/icon_256x256.png"
sips -z 512 512 "$SRC" --out "$ICONSET/icon_256x256@2x.png"
sips -z 512 512 "$SRC" --out "$ICONSET/icon_512x512.png"
cp "$SRC" "$ICONSET/icon_512x512@2x.png"

if iconutil -c icns "$ICONSET" -o "$ICONS_DIR/icon.icns" 2>/dev/null; then
  echo "Created $ICONS_DIR/icon.icns with iconutil."
else
  echo "iconutil failed; run: npm run tauri icon $ICONS_DIR/icon-1024-stripped.png"
fi
rm -rf "$ICONSET"
