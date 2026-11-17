"use strict";
// The theme role table: the 47 colour roles a theme sets, which of them may be translucent, the font and radius vocabulary,
// and Cyno, the built-in default theme. Cyno is transcribed from the `:root, [data-theme="cyno"]` block of the themes draft
// (tokens.themes-draft.css); a test of the synced tokens.css pins it later. Pure data, no Electron.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CYNO = exports.FONT_STACKS = exports.FONT_NAMES = exports.ROLE_FALLBACKS = exports.ALPHA_KEYS = exports.ROLE_KEYS = void 0;
exports.ROLE_KEYS = Object.freeze([
    '--c-void', '--c-void-2', '--c-nebula', '--c-nebula-2', '--c-line', '--c-line-soft',
    '--c-fg', '--c-fg-muted', '--c-fg-dim',
    '--c-ice', '--c-ice-2',
    '--c-red', '--c-red-2', '--c-red-glow',
    '--c-blue', '--c-blue-2', '--c-blue-glow',
    '--c-green', '--c-green-glow',
    '--c-white-hot', '--c-ok', '--c-warn', '--c-bad', '--c-focus',
    '--c-window', '--c-frame', '--c-map', '--c-stripe-a', '--c-stripe-b',
    '--c-glass', '--c-glass-head', '--c-glass-panel', '--c-glass-chip',
    '--c-well', '--c-well-soft', '--c-scrim', '--c-scrim-strong', '--c-scrim-soft', '--c-shadow',
    '--c-pal-blue', '--c-pal-orange', '--c-pal-green', '--c-pal-magenta', '--c-pal-lime', '--c-pal-violet', '--c-pal-rose', '--c-pal-gold',
]);
/** The 14 translucent roles: only these may be written `#rrggbbaa`. */
exports.ALPHA_KEYS = new Set([
    '--c-line-soft', '--c-red-glow', '--c-blue-glow', '--c-green-glow',
    '--c-glass', '--c-glass-head', '--c-glass-panel', '--c-glass-chip', '--c-well', '--c-well-soft', '--c-scrim', '--c-scrim-strong', '--c-scrim-soft', '--c-shadow',
]);
/**
 * A role a theme (and its variant) leaves unset takes another role the theme sets, not Cyno's value: these roles came after
 * the role table, and Cyno's value would not suit every theme (Cyno's near-black palette scrim, or its ice focus ring, on a light theme). When the
 * theme sets neither, the role is Cyno's, like any other. Cyno sets its own value for each. Pairs: [role, its source role].
 */
exports.ROLE_FALLBACKS = Object.freeze([
    Object.freeze(['--c-focus', '--c-ice']),
    Object.freeze(['--c-scrim-soft', '--c-scrim']),
]);
/** The display names a theme.json may use for a font, and the key each stands for. */
exports.FONT_NAMES = Object.freeze({
    'Space Grotesk': 'space-grotesk',
    'Figtree': 'figtree',
    'JetBrains Mono': 'jetbrains-mono',
    'System default': 'system',
});
/**
 * The CSS font stack of each bundled font per role, transcribed from the `--font-*` declarations of the themes draft
 * (tokens.themes-draft.css:32-36). `system` is `--font-system` for Display and Body and `--font-system-mono` for Mono.
 * The plugin API hands these out as names only (R14): a plugin that wants the font must bundle it.
 */
const SANS_SYSTEM = 'system-ui, sans-serif';
const MONO_SYSTEM = 'ui-monospace, "SF Mono", Consolas, monospace';
const stacks = (system) => ({
    'space-grotesk': '"Space Grotesk", system-ui, sans-serif',
    'figtree': '"Figtree", system-ui, sans-serif',
    'jetbrains-mono': '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace',
    'system': system,
});
exports.FONT_STACKS = Object.freeze({
    display: Object.freeze(stacks(SANS_SYSTEM)),
    body: Object.freeze(stacks(SANS_SYSTEM)),
    mono: Object.freeze(stacks(MONO_SYSTEM)),
});
/** Cyno. `rgba(r, g, b, a)` of the draft is `#rrggbbaa` here, alpha = round(a * 255). */
const CYNO_VALUES = {
    scheme: 'dark',
    roles: {
        '--c-void': '#06080c',
        '--c-void-2': '#0b0f17',
        '--c-nebula': '#121a28',
        '--c-nebula-2': '#1b2638',
        '--c-line': '#2a3a55',
        '--c-line-soft': '#19223340',
        '--c-fg': '#e8eef7',
        '--c-fg-muted': '#8595b0',
        '--c-fg-dim': '#7e8da9',
        '--c-ice': '#4ad6f5',
        '--c-ice-2': '#00b6d9',
        '--c-red': '#ff8c3d',
        '--c-red-2': '#ffba6e',
        '--c-red-glow': '#ff8c3d8c',
        '--c-blue': '#7d8bff',
        '--c-blue-2': '#a5b4ff',
        '--c-blue-glow': '#7d8bff8c',
        '--c-green': '#5fd0a8',
        '--c-green-glow': '#5fd0a880',
        '--c-white-hot': '#f5fbff',
        '--c-ok': '#6ed878',
        '--c-warn': '#ffb84d',
        '--c-bad': '#ff5b6a',
        '--c-focus': '#4ad6f5',
        '--c-window': '#030507',
        '--c-frame': '#080b11',
        '--c-map': '#06090e',
        '--c-stripe-a': '#0a0e15',
        '--c-stripe-b': '#0c121b',
        '--c-glass': '#0b0f17c7',
        '--c-glass-head': '#0b0f17cc',
        '--c-glass-panel': '#0b0f17b3',
        '--c-glass-chip': '#121a2899',
        '--c-well': '#00000059',
        '--c-well-soft': '#00000040',
        '--c-scrim': '#030508bd',
        '--c-scrim-strong': '#030508d1',
        '--c-scrim-soft': '#0305088c',
        '--c-shadow': '#0000008c',
        '--c-pal-blue': '#7d8bff',
        '--c-pal-orange': '#ff8c3d',
        '--c-pal-green': '#5fd0a8',
        '--c-pal-magenta': '#e07ad0',
        '--c-pal-lime': '#b6d957',
        '--c-pal-violet': '#bc98f9',
        '--c-pal-rose': '#f486aa',
        '--c-pal-gold': '#cbb94c',
    },
    glow: 45,
    fonts: { display: 'space-grotesk', body: 'space-grotesk', mono: 'jetbrains-mono' },
    radius: { base: 2, sm: 3, md: 4, lg: 6 },
};
/** Frozen (deep): later tasks merge theme maps onto copies, never onto this. */
exports.CYNO = Object.freeze({
    ...CYNO_VALUES,
    roles: Object.freeze(CYNO_VALUES.roles),
    fonts: Object.freeze(CYNO_VALUES.fonts),
    radius: Object.freeze(CYNO_VALUES.radius),
});
