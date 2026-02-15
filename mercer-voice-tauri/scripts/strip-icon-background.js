#!/usr/bin/env node
/**
 * Strip background (dark and white) from the app icon so only the purple waveform remains.
 * - Reads 128x128.png → writes src/icon.png (for in-app pill).
 * - Reads icon-1024.png → writes icon-1024-stripped.png (for regenerating dock .icns).
 * Run: node scripts/strip-icon-background.js
 * Then run: npm run tauri icon src-tauri/icons/icon-1024-stripped.png
 * to regenerate icon.icns so the Mac dock icon has no white corners.
 */
const sharp = require('sharp');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'src-tauri', 'icons');

function stripWhiteAndBackground(data, info, edge, cornerR) {
    const { width, height, channels } = info;

    function inCornerCutout(px, py) {
        const L = edge;
        const R = cornerR;
        const left = L;
        const right = width - 1 - L;
        const top = L;
        const bottom = height - 1 - L;
        const cxTL = left + R, cyTL = top + R;
        const cxTR = right - R, cyTR = top + R;
        const cxBL = left + R, cyBL = bottom - R;
        const cxBR = right - R, cyBR = bottom - R;
        if (px <= left + R && py <= top + R && (px - cxTL) ** 2 + (py - cyTL) ** 2 > R * R) return true;
        if (px >= right - R && py <= top + R && (px - cxTR) ** 2 + (py - cyTR) ** 2 > R * R) return true;
        if (px <= left + R && py >= bottom - R && (px - cxBL) ** 2 + (py - cyBL) ** 2 > R * R) return true;
        if (px >= right - R && py >= bottom - R && (px - cxBR) ** 2 + (py - cyBR) ** 2 > R * R) return true;
        return false;
    }
    function insideRoundedRect(px, py) {
        const L = edge;
        const left = L, right = width - 1 - L, top = L, bottom = height - 1 - L;
        if (px < left || px > right || py < top || py > bottom) return false;
        return !inCornerCutout(px, py);
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * channels;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const gray = (r + g + b) / 3;
            const isPurple = b > 80 && r > 50 && (r + b) > g + 80;
            const isBright = gray > 145;
            const isWhite = gray > 200;
            const inShape = insideRoundedRect(x, y);
            const keep = inShape && (isPurple || (isBright && !isWhite));
            if (!keep) {
                data[i] = 0;
                data[i + 1] = 0;
                data[i + 2] = 0;
                data[i + 3] = 0;
            }
        }
    }
}

async function processIcon(inputPath, outputPath, edge, cornerR) {
    const { data, info } = await sharp(inputPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    stripWhiteAndBackground(data, info, edge, cornerR);

    await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .png()
        .toFile(outputPath);

    console.log('Wrote', outputPath);
}

async function main() {
    await processIcon(
        path.join(ICONS_DIR, '128x128.png'),
        path.join(ROOT, 'src', 'icon.png'),
        5,
        28
    );

    const icon1024 = path.join(ICONS_DIR, 'icon-1024.png');
    try {
        await require('fs').promises.access(icon1024);
    } catch {
        console.log('Skipping icon-1024 (file not found). Run: npm run tauri icon <your-1024.png> to regenerate dock icon.');
        return;
    }

    await processIcon(
        icon1024,
        path.join(ICONS_DIR, 'icon-1024-stripped.png'),
        40,
        224
    );

    console.log('');
    console.log('To update the Mac dock icon, run:');
    console.log('  npm run tauri icon src-tauri/icons/icon-1024-stripped.png');
    console.log('  npm run tauri build  (or your usual build)');
    console.log('Then clear the icon cache so macOS shows the new icon:');
    console.log('  ./scripts/clear-mac-icon-cache.sh');
    console.log('(Or: sudo rm -rf /Library/Caches/com.apple.iconservices.store && killall Dock)');
    console.log('Fully quit the app and open the newly built app. If the dock still shows white, log out and back in.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
