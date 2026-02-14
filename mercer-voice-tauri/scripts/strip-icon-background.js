#!/usr/bin/env node
/**
 * Strip dark background and border from the app icon so only the purple waveform remains.
 * Reads from src-tauri/icons/128x128.png, writes to src/icon.png (for pill display).
 * Run: node scripts/strip-icon-background.js
 */
const sharp = require('sharp');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INPUT = path.join(ROOT, 'src-tauri/icons/128x128.png');
const OUTPUT = path.join(ROOT, 'src/icon.png');

async function main() {
    const { data, info } = await sharp(INPUT)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const edge = 5;
    const cornerR = 28; // corner radius of the rounded rect in the source icon

    // True if (x,y) is in one of the four corner cutouts (outside the rounded rect)
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
            const inShape = insideRoundedRect(x, y);
            if (!inShape || (!isPurple && !isBright)) {
                data[i + 3] = 0;
            }
        }
    }

    await sharp(data, { raw: { width, height, channels } })
        .png()
        .toFile(OUTPUT);

    console.log('Wrote', OUTPUT);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
