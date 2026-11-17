"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ICONS = exports.PALETTE = void 0;
exports.fnv1a32 = fnv1a32;
exports.paletteClass = paletteClass;
exports.iconFor = iconFor;
exports.PALETTE = [
    { cls: 'c-intel', hex: '#ff8c3d', slot: 'orange' }, { cls: 'c-fleets', hex: '#7d8bff', slot: 'blue' }, { cls: 'c-abyss', hex: '#5fd0a8', slot: 'green' },
    { cls: 'c-multi', hex: '#b6d957', slot: 'lime' }, { cls: 'c-jf', hex: '#e07ad0', slot: 'magenta' }, { cls: 'c-ai', hex: '#bc98f9', slot: 'violet' }, { cls: 'c-fit', hex: '#cbb94c', slot: 'gold' },
];
/** The icon names of R5 (IC:10): `plugin` is the generic fallback. The manifest pattern `^[a-z]{1,24}$` lets any lower-case word through; this list decides what is drawn. */
exports.ICONS = [
    'radar', 'flag', 'vortex', 'grid', 'truck', 'spark', 'cpu', 'rocket', 'wrench', 'chart', 'coin', 'map', 'crosshair', 'book', 'clock', 'box',
    'satellite', 'asteroid', 'planet', 'factory', 'compass', 'plugin',
];
const HEX = /^#[0-9a-fA-F]{6}$/;
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
/** FNV-1a, 32 bits, over the UTF-8 bytes. */
function fnv1a32(s) {
    let h = 0x811c9dc5;
    for (const b of Buffer.from(s, 'utf8')) {
        h ^= b;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}
/** The palette class of a plugin: the nearest palette colour to `color`, else FNV-1a-32(id) mod 7 (ties go to the first). */
function paletteClass(m) {
    if (m.color !== undefined && HEX.test(m.color)) {
        const c = rgb(m.color);
        let best = 0, bestD = Infinity;
        exports.PALETTE.forEach((p, i) => {
            const q = rgb(p.hex);
            const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        });
        return exports.PALETTE[best].cls;
    }
    return exports.PALETTE[fnv1a32(m.id) % exports.PALETTE.length].cls;
}
/** The icon of a plugin; an unknown or missing name (`layers`, a host icon, included) is `plugin`. */
function iconFor(m) {
    return exports.ICONS.includes(m.icon ?? '') ? m.icon : 'plugin';
}
