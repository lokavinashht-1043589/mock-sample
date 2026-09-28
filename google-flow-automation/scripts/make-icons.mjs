// Generates icons/icon{16,48,128}.png (rounded square + play triangle). No dependencies.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
};

function icon(size) {
    const raw = Buffer.alloc(size * (size * 4 + 1));
    const r = size * 0.22;
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        for (let x = 0; x < size; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            const dx = Math.max(r - px, 0, px - (size - r));
            const dy = Math.max(r - py, 0, py - (size - r));
            const inside = dx * dx + dy * dy <= r * r;
            // play triangle
            const tx = (px - size * 0.36) / (size * 0.36);
            const ty = Math.abs(py - size / 2) / (size * 0.26);
            const inTri = tx >= 0 && tx <= 1 && ty <= 1 - tx;
            const t = y / size;
            const color = inTri ? [255, 255, 255] : [Math.round(59 + 40 * t), Math.round(91 - 30 * t), Math.round(219 - 10 * t)];
            const o = y * (size * 4 + 1) + 1 + x * 4;
            raw[o] = color[0];
            raw[o + 1] = color[1];
            raw[o + 2] = color[2];
            raw[o + 3] = inside ? 255 : 0;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [16, 48, 128]) writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), icon(size));
console.log('icons written');
