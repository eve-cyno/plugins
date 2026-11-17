"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkHard = exports.REQUEST_MIN_DISTANCE = exports.LOW_ACCENT = exports.ACCENT_CHECKS = exports.HARD_CHECKS = void 0;
exports.hexToRgba = hexToRgba;
exports.ratio = ratio;
exports.over = over;
exports.mix = mix;
exports.oklabDistance = oklabDistance;
exports.checkValues = checkValues;
/** `#rrggbb` or `#rrggbbaa` to channels 0-255 and alpha 0-1. */
function hexToRgba(s) {
    const n = (i) => parseInt(s.slice(i, i + 2), 16);
    return [n(1), n(3), n(5), s.length === 9 ? n(7) / 255 : 1];
}
const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
function ratio(fg, bg) {
    const x = lum(fg), y = lum(bg);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** `fg` over an opaque `bg`, in sRGB. */
function over(fg, bg) {
    const a = fg[3];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}
/** `p` (0-1) of `a` mixed into `b`, in sRGB (CSS `color-mix(in srgb, a p, b)`). */
function mix(a, p, b) {
    return [a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), a[2] * p + b[2] * (1 - p)];
}
/** Euclidean distance in OKLab between two opaque `#rrggbb` colours. */
function oklabDistance(a, b) {
    const lab = (s) => {
        const [r, g, bl] = hexToRgba(s).slice(0, 3).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
        const sv = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
        return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * sv, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * sv, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * sv];
    };
    const x = lab(a), y = lab(b);
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
/** Hard: a failure refuses the variant, or the theme when its base fails. */
exports.HARD_CHECKS = [
    { label: 'fg on the window', ink: '--c-fg', ground: 'void', min: 4.5 },
    { label: 'fg on bars and dialogs', ink: '--c-fg', ground: 'void-2', min: 4.5 },
    { label: 'fg on tiles', ink: '--c-fg', ground: 'glass', min: 4.5 },
    { label: 'muted text on the window', ink: '--c-fg-muted', ground: 'void', min: 3 },
    { label: 'muted text on tiles', ink: '--c-fg-muted', ground: 'glass', min: 3 },
    { label: 'muted text on raised surface', ink: '--c-fg-muted', ground: 'nebula', min: 3 },
    { label: 'dim text on the window', ink: '--c-fg-dim', ground: 'void', min: 3 },
    { label: 'dim text on tiles', ink: '--c-fg-dim', ground: 'glass', min: 3 },
    { label: 'dim text on chips', ink: '--c-fg-dim', ground: 'chip', min: 3 },
    { label: 'dim text on raised surface', ink: '--c-fg-dim', ground: 'nebula', min: 3 },
];
/** The default accent variant (or a base without variants) must pass these. */
exports.ACCENT_CHECKS = [
    { label: 'accent text on the window', ink: '--c-ice', ground: 'void', min: 3 },
    { label: 'request label on the request title bar', ink: '--c-ice', ground: 'rq', min: 3 },
    { label: 'request bar edge against a normal bar', ink: '--c-ice', ground: 'void-2', min: 3 },
    { label: 'primary button text', ink: '--c-void', ground: 'ice', min: 4.5 },
];
exports.LOW_ACCENT = 3;
exports.REQUEST_MIN_DISTANCE = 0.02;
const REQUEST_SLOTS = [
    ['--c-pal-blue', 'the blue plugin colour'], ['--c-pal-orange', 'the orange plugin colour'], ['--c-pal-green', 'the green plugin colour'],
    ['--c-pal-magenta', 'the magenta plugin colour'], ['--c-pal-lime', 'the lime plugin colour'], ['--c-pal-violet', 'the violet plugin colour'],
    ['--c-pal-rose', 'the rose plugin colour'], ['--c-pal-gold', 'the gold plugin colour'],
    ['--c-ok', 'the ok colour'], ['--c-warn', 'the attention colour'], ['--c-bad', 'the alert colour'],
];
function grounds(r) {
    const rgb = (k) => hexToRgba(r[k]);
    const v = rgb('--c-void').slice(0, 3), v2 = rgb('--c-void-2').slice(0, 3), ice = rgb('--c-ice').slice(0, 3);
    return { 'void': v, 'void-2': v2, glass: over(rgb('--c-glass'), v), nebula: over(rgb('--c-nebula'), v), chip: over(rgb('--c-glass-chip'), v2), rq: mix(ice, 0.16, v2), ice };
}
const ratioOf = (c, r, g) => ratio(hexToRgba(r[c.ink]).slice(0, 3), g[c.ground]);
const failText = (c, x) => `${c.label} is ${x.toFixed(2)}:1, needs ${c.min}:1`;
const hardFail = (v, g) => {
    for (const c of exports.HARD_CHECKS) {
        const x = ratioOf(c, v.roles, g);
        if (!(x >= c.min))
            return failText(c, x);
    }
    return null;
};
/** The first failed hard check, or null. A value that does not parse (NaN) fails: the checks fail closed. */
const checkHard = (v) => hardFail(v, grounds(v.roles));
exports.checkHard = checkHard;
/** Hard checks, then (for the default) the accent checks, then the request-state rule. `low` is the advisory accent flag. */
function checkValues(v, isDefault) {
    const g = grounds(v.roles);
    const low = ratio(g.ice, g['void']) < exports.LOW_ACCENT;
    const hard = hardFail(v, g);
    if (hard)
        return { fail: hard, low };
    if (isDefault) {
        for (const c of exports.ACCENT_CHECKS) {
            const x = ratioOf(c, v.roles, g);
            if (!(x >= c.min))
                return { fail: failText(c, x), low };
        }
    }
    const ice = v.roles['--c-ice'].slice(0, 7);
    for (const [k, what] of REQUEST_SLOTS) {
        const o = v.roles[k].slice(0, 7);
        if (o === ice || !(oklabDistance(ice, o) >= exports.REQUEST_MIN_DISTANCE))
            return { fail: `the accent is the same colour as ${what}`, low };
    }
    return { fail: null, low };
}
