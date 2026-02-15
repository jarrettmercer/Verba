#!/bin/bash
# Regenerate icon.icns (transparent corners, no white) and copy into built app bundle(s).
# Run from repo root. Then run: ./scripts/clear-mac-icon-cache.sh and restart the app.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "1. Stripping white from icon and generating icon-1024-stripped.png..."
node scripts/strip-icon-background.js 2>&1 | grep -v "^To update" || true

echo ""
echo "2. Regenerating icon.icns (Tauri)..."
npm run tauri icon src-tauri/icons/icon-1024-stripped.png 2>&1 | tail -3

echo ""
echo "3. Copying new icon into built app bundle(s)..."
ICON_SRC="$ROOT/src-tauri/icons/icon.icns"
for app in "$ROOT/src-tauri/target/release/bundle/macos/"*.app "$ROOT/src-tauri/target/debug/bundle/macos/"*.app; do
  if [[ -d "$app" ]]; then
    res="$app/Contents/Resources/icon.icns"
    if [[ -f "$res" ]]; then
      cp "$ICON_SRC" "$res"
      echo "   Updated: $app"
    fi
  fi
done 2>/dev/null || true

echo ""
echo "4. Next steps:"
echo "   - Quit the app completely."
echo "   - Run: ./scripts/clear-mac-icon-cache.sh"
echo "   - Open the app again from the .app bundle."
echo "   - If the dock still shows the old icon: log out and back in (or restart)."
