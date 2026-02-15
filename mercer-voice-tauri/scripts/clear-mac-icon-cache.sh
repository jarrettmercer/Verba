#!/bin/bash
# Clear macOS icon caches so the Dock and Finder show the updated app icon.
# Run after rebuilding the app with a new icon.icns.
# You may need to enter your password for sudo.

set -e
echo "Clearing icon caches..."
sudo rm -rf /Library/Caches/com.apple.iconservices.store 2>/dev/null || true
sudo find /private/var/folders -name 'com.apple.dock.iconcache' -delete 2>/dev/null || true
sudo find /private/var/folders -name 'com.apple.iconservices' -exec rm -rf {} + 2>/dev/null || true
killall Dock 2>/dev/null || true
killall Finder 2>/dev/null || true
echo "Done. If the dock icon still looks old: fully quit the app, open it again, or log out and back in."
