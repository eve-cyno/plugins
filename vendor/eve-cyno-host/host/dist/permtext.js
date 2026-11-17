"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NAME_CAP = exports.resetLine = exports.perCharacterNoteText = exports.perCharacterNoteTails = exports.NOTE_LEAD = exports.PER_CHARACTER_TEXT = exports.backgroundLine = exports.readObject = void 0;
exports.scopeLabel = scopeLabel;
exports.optionalLine = optionalLine;
exports.permLines = permLines;
exports.permTags = permTags;
exports.capName = capName;
exports.optionalOnly = optionalOnly;
exports.permSummary = permSummary;
// Plain-words permission lines for the badge list and the permission prompt (B4a). Pure (no Electron, no vault, no
// registry): the character count and the provider names are injected. The copy states who can see what.
const scope_labels_json_1 = __importDefault(require("./schemas/scope-labels.json"));
const service_labels_json_1 = __importDefault(require("./schemas/service-labels.json"));
const manifest_1 = require("./manifest");
const windowsview_1 = require("./windowsview");
const grants_1 = require("./grants");
const optional_1 = require("./optional");
const numfmt_gen_1 = require("./numfmt.gen");
const SCOPE = /^esi-([a-z]+)\.([a-z]+)_([a-z_]+)\.v[0-9]+$/;
const TABLE = scope_labels_json_1.default;
/** H13: what a consumer of a service learns, keyed `<interface>@<built-in provider id>`: the wording belongs to that provider, so a third-party plugin that provides the same interface does not get it. The host owns the wording, not the provider; `{provider}` is the installed provider's name. */
const SERVICE_TEXT = service_labels_json_1.default;
/** A short plain label for an ESI scope: the table, else derived (`esi-<group>.<verb>_<thing>.v<n>` -> "<Verb> <group> <thing>"), else the scope itself. */
function scopeLabel(scope) {
    if (Object.hasOwn(TABLE, scope))
        return TABLE[scope];
    const m = SCOPE.exec(scope);
    if (!m)
        return scope;
    const verb = m[2][0].toUpperCase() + m[2].slice(1);
    return `${verb} ${m[1]} ${m[3].replace(/_/g, ' ')}`;
}
/** The label of a read scope without its verb, for a sentence that already says "read" (other verbs keep theirs, lower-cased): "Read your assets" -> "your assets", "Search for structures" -> "structures". */
const readObject = (scope) => {
    const label = scopeLabel(scope);
    const bare = label.replace(/^(?:Read|Search for) /, '');
    // Other verbs stay in the sentence ("read, for its characters: ..., track corporation members"), so the label only loses its capital.
    return bare !== label ? bare : label.charAt(0).toLowerCase() + label.slice(1);
};
exports.readObject = readObject;
// API 1.2.0: what each game-event family says in the consent line.
const FAMILY_WORDS = {
    combat: 'damage, misses and repairs', ewar: 'warp disruption, jamming and energy drain', mining: 'mining', notice: 'jumps and docking',
};
const host = (origin) => { try {
    return new URL(origin).host;
}
catch {
    return origin;
} };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const lcFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
/** "A", "A and B", "A, B and C". */
const listed = (names) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
/** The A4 row: the manifest keeps the plugin running while its view is closed. */
const backgroundLine = (suspendUnderPressure = false) => ({
    kind: 'background', title: 'Keep running when its view is closed',
    detail: suspendUnderPressure ? 'The host does not pause the plugin when you leave its view, but stops it when your computer runs low on memory and its view has been hidden for 30 minutes.' : 'The host does not pause the plugin when you leave its view.',
    mono: [],
});
exports.backgroundLine = backgroundLine;
/**
 * The row of one optional item (optional permissions, plan 2026-11-09; board texts, host wording only): an ESI scope by its label with the scope in mono, a server as
 * "Contact <host>", the clipboard and notifications as their required rows read. `line` is the row the shared builder made for a grant of this one item; null for a key
 * that names nothing (the caller skips it). The `optional` marker is the key as optional.ts keeps it.
 */
function optionalLine(key, line) {
    if (key.startsWith('esi:')) {
        const scope = key.slice('esi:'.length);
        const write = scope.includes('.write_');
        // Assets M3, H-A (board B1.3): a scope the registry marks per character says where it is turned on, in its group's words (Fit L8, CD-6); every
        // other row keeps its text.
        const group = (0, optional_1.perCharacterGroupOf)(scope);
        if (group !== undefined) {
            return { kind: 'esi', title: scopeLabel(scope), mono: [scope], optional: { key }, perCharacter: true, detail: groupText(group).detail };
        }
        return {
            kind: 'esi', title: scopeLabel(scope), mono: [scope], optional: { key },
            detail: write ? 'Through ESI, once per click of yours, for its characters.' : 'Through ESI, for its characters. It sees only what this allows.',
        };
    }
    if (key.startsWith('network:')) {
        return { kind: 'network', title: `Contact ${host(key.slice('network:'.length))}`, detail: 'The plugin can send data to this server, and it sees what the plugin sends.', mono: [], optional: { key } };
    }
    return line === undefined ? null : { ...line, optional: { key } };
}
/**
 * The host's words for each group of the registry's per-character scopes (optional.ts perCharacterGroupOf): the detail of a marked optional row and the
 * prompt note. "corporation data": Assets M3, H-A, board B1.3. "saving fittings": Fit L8, coordinator ruling CD-6 (the permission detail and the Privacy
 * note, verbatim). "blueprint details": Assets M4, H3, C3.3 (board m4-notes, approved by the coordinator 2026-11-14). "structure markets": Assets
 * M4, P5c, C3.3 (board m4-notes; its note says only Everything already holds the scope, which no read bundle holds). Every group the registry names has
 * an entry (selftest-prompts PERM-opt-groups-have-texts), and every note starts with NOTE_LEAD. `again` (board m4-4): the sentence a grant adds (boards m4-4, m4-4c) after
 * the group's note when it asks one of `scopes` of a plugin that held another scope of the group before (a character may already have the group on).
 */
exports.PER_CHARACTER_TEXT = {
    'corporation data': {
        detail: 'Through ESI, only for the characters you turn it on for in Settings > Characters.',
        note: 'Allow starts no sign-in. To use these, turn on corporation data for a character in Settings > Characters: only that character is re-authorised. Characters on All read-only scopes or Everything already have them.',
        again: { scopes: ['esi-corporations.read_blueprints.v1'], text: 'A character that already has corporation data on presses Turn on again to add corporation blueprints.' },
    },
    'saving fittings': {
        detail: 'Through ESI. You confirm each save and delete in a host dialog. Only for characters with saving fittings on in Settings > Characters (every character on Everything).',
        note: 'Allow starts no sign-in. To save fittings, turn on saving fittings for a character in Settings > Characters: only that character is re-authorised. Characters on Everything already have it.',
    },
    'blueprint details': {
        detail: 'Through ESI, only for the characters you turn it on for in Settings > Characters.',
        note: 'Allow starts no sign-in. To use it, turn on blueprint details for a character in Settings > Characters: only that character is re-authorised. Characters on All read-only scopes or Everything already have it.',
    },
    'structure markets': {
        detail: 'Through ESI, only for the characters you turn it on for in Settings > Characters. A structure’s market is readable only by a character that can dock there.',
        note: 'Allow starts no sign-in. To read the market of a structure, turn on structure markets for a character in Settings > Characters: only that character is re-authorised. Characters on Everything already have it; All read-only scopes does not include it.',
    },
};
// A group without its own words gets the plain per-character ones (true of any group); the selftest keeps every registry group out of this branch.
const groupText = (group) => Object.hasOwn(exports.PER_CHARACTER_TEXT, group) ? exports.PER_CHARACTER_TEXT[group] : {
    detail: 'Through ESI, only for the characters you turn it on for in Settings > Characters.',
    note: `Allow starts no sign-in. To use these, turn on ${group} for a character in Settings > Characters: only that character is re-authorised.`,
};
/** The first sentence of every group's note. A prompt shows it once, then each group's tail (board m4-4 ruling, Assets M4). */
exports.NOTE_LEAD = 'Allow starts no sign-in.';
const tailOf = (note) => (note.startsWith(`${exports.NOTE_LEAD} `) ? note.slice(exports.NOTE_LEAD.length + 1) : note);
/**
 * The note's part for each group of `scopes`, each group once, in the order its scopes come: the group's note without NOTE_LEAD (its tail), plus its
 * `again` sentence when `heldBefore` (the scopes the plugin held before, given whenever the ask has a `previous` grant) holds a scope of that group outside `scopes` and
 * `scopes` asks one of `again.scopes`.
 */
const perCharacterNoteTails = (scopes, heldBefore = []) => [...new Set(scopes.map(optional_1.perCharacterGroupOf).filter((g) => g !== undefined))].map(group => {
    const t = groupText(group);
    const mine = scopes.filter(s => (0, optional_1.perCharacterGroupOf)(s) === group);
    const again = t.again !== undefined && mine.some(s => t.again.scopes.includes(s)) && heldBefore.some(s => (0, optional_1.perCharacterGroupOf)(s) === group && !mine.includes(s));
    return { group, text: again ? `${tailOf(t.note)} ${t.again.text}` : tailOf(t.note) };
});
exports.perCharacterNoteTails = perCharacterNoteTails;
/**
 * Assets M3, H-A (board B1.3): the prompt note shown while a marked optional row is switched on (or always, for a marked required scope). `scopes`: the
 * prompt's marked scopes, in the rows' order. Fit L8: a prompt may hold several groups. Assets M4 (board m4-4): NOTE_LEAD once, then each group's tail
 * (perCharacterNoteTails), so one group alone reads its whole note byte for byte. '' without a marked scope.
 */
const perCharacterNoteText = (scopes, heldBefore = []) => {
    const tails = (0, exports.perCharacterNoteTails)(scopes, heldBefore);
    return tails.length === 0 ? '' : [exports.NOTE_LEAD, ...tails.map(t => t.text)].join(' ');
};
exports.perCharacterNoteText = perCharacterNoteText;
/**
 * The A5 row of a prompt that clears the plugin's stored data (the plugin could see names and can now send data out). `either`: the data is cleared whatever the answer
 * (an in-place update whose required part fires the reset and that asks only about optional items: a refusal keeps the update, so it clears the data too), and the row says so.
 * `ifAllowed` (option e, `denyRuns`): a Deny keeps the plugin running and clears nothing, so the row says the data is cleared only if the user allows it. Copy only.
 */
const resetLine = (name, either = false, ifAllowed = false) => ({
    kind: 'reset', title: 'Its stored data is cleared',
    detail: `${name} could see names from your EVE windows or game logs. It can now send data out, so its stored data is cleared${ifAllowed && !either ? ' if you allow it' : ''}. Its thumbnail layout is kept where it used EVE-Cyno's character keys.${either ? ' It is cleared whatever you answer.' : ''}`,
    mono: [],
});
exports.resetLine = resetLine;
/** Who the plugin can pass data to, by name, from the whole grant (`canSendOut` says whether; this says to whom). */
function waysOut(whole, ctx) {
    const names = whole.network.map(host);
    for (const [iface, s] of Object.entries(whole.services))
        names.push(s.provider !== null ? ctx.providerNames(s.provider) : iface);
    if (whole.flags.ai)
        names.push('your AI provider');
    if (whole.flags.account)
        names.push('your EVE-Cyno account');
    if (ctx.provides)
        names.push('the plugins that use its services');
    return [...new Set(names)];
}
/** H13: the consent text of a service consumer: what it learns, and, when it can send data out, where that could go. `{provider}` is the name wherever it stands (L7: a text may name it more than once). */
const serviceLearns = (text, provider, out) => `${text.replaceAll('{provider}', provider)}${out.length > 0 ? ` What it learns could reach ${listed(out)}.` : ''}`;
/** The permission lines of a grant, in a fixed order. Nothing granted gives no line. */
function permLines(g, ctx) {
    const out = [];
    const services = Object.entries(g.services);
    // "Send out": the plugin has a way to pass data on (a server, a service, the AI or the account). Read from the whole grant: a line of the
    // delta must not miss a way out (or a window feature) the plugin already holds.
    const whole = ctx.whole ?? g;
    const sendsOut = (0, windowsview_1.canSendOut)(whole, ctx.provides);
    const wf = whole.flags;
    // Who the data could reach: named from `reach` (a prompt's whole with every new optional item on), so the list never leaves out a way out a switch can add.
    const reach = ctx.reach ?? whole;
    const outTo = (0, windowsview_1.canSendOut)(reach, ctx.provides) ? waysOut(reach, ctx) : [];
    if (g.characters === 'all') {
        out.push({ kind: 'characters', title: 'See all your characters', detail: 'The plugin sees the name and id of every character you sign in, now and later.', mono: [] });
    }
    else if (g.characters === 'selected') {
        const n = ctx.characterCount(g);
        out.push({
            kind: 'characters', title: n === null ? 'See the characters you choose' : `See ${plural(n, 'selected character', 'selected characters')}`,
            detail: n === null ? 'The plugin sees the name and id of the characters you pick, and no others.' : 'The plugin sees the name and id of the characters you picked, and no others.', mono: [],
        });
    }
    const esiWrites = g.esi.filter(s => s.includes('.write_')), esiReads = g.esi.filter(s => !s.includes('.write_'));
    if (esiReads.length > 0) {
        out.push({
            kind: 'esi', title: 'Read EVE data through ESI',
            detail: `Lets the plugin read, for its characters: ${esiReads.map(exports.readObject).join(', ')}. It sees only what these allow.`, mono: esiReads,
        });
    }
    if (esiWrites.length > 0) {
        out.push({
            kind: 'esi', title: 'Act in your EVE client through ESI',
            detail: `Lets the plugin, once per click of yours, for its characters: ${esiWrites.map((s, i) => i === 0 ? scopeLabel(s) : lcFirst(scopeLabel(s))).join(', ')}.`, mono: esiWrites,
        });
    }
    if (g.network.length > 0) {
        out.push({
            kind: 'network', title: `Contact ${plural(g.network.length, 'server', 'servers')}`,
            detail: g.network.length === 1 ? 'The plugin can send data to this server, and it sees what the plugin sends.' : 'The plugin can send data to these servers, and they see what it sends.', mono: g.network.map(host),
        });
    }
    for (const [iface, s] of services) {
        const known = s.provider !== null && Object.hasOwn(ctx.providers, iface) && ctx.providers[iface].pluginId === s.provider;
        const other = s.provider !== null && !known && Object.hasOwn(ctx.providers, iface);
        const name = s.provider !== null ? ctx.providerNames(s.provider) : 'a plugin not installed yet';
        const hosts = known ? ctx.providers[iface].hosts.map(host) : [];
        const detail = s.provider === null ? 'No installed plugin provides this service yet. Once one does, it sees what this plugin sends it.'
            : other ? `${name} was chosen; another plugin provides it now.`
                : !known ? `${name} was chosen; it is not installed now. Whatever provides this service sees what this plugin sends it.`
                    : Object.hasOwn(SERVICE_TEXT, `${iface}@${s.provider}`) ? serviceLearns(SERVICE_TEXT[`${iface}@${s.provider}`], name, outTo.filter(n => n !== name))
                        : `${name} can reach ${hosts.length > 0 ? hosts.join(', ') : 'no servers'}, and sees what the plugin sends it.`;
        out.push({ kind: 'services', title: `Use a service from ${name}`, detail, mono: hosts });
    }
    if (g.logs.includes('gamelogs')) {
        out.push({ kind: 'logs', title: 'Read game logs', detail: 'The plugin reads your game logs for its characters, as the game writes them.', mono: ['gamelogs'] });
    }
    if (g.logs.includes('chatlogs')) {
        const also = outTo.length > 0 ? ` This plugin can also send data to ${listed(outTo)}.` : '';
        out.push({ kind: 'logs', title: 'Read chat channels', detail: `Read the chat channels you pick: the author and the text of every line. No other channel is read.${also}`, mono: ['chatlogs'] });
    }
    if (g.gameEvents.length > 0) {
        // Input, not data-out (canSendOut ignores it): whether other players' names reach the plugin follows the way out of the WHOLE grant (spec 4.4).
        const families = grants_1.GAME_EVENT_FAMILIES.filter(f => g.gameEvents.includes(f));
        out.push({
            kind: 'gameEvents', title: 'Read game events from your logs',
            detail: `The plugin reads what your game logs say happened (${families.map(f => FAMILY_WORDS[f]).join('; ')}) for every character you play on this computer, whichever characters you allow it for. It never sees chat or the raw log files.${sendsOut ? ' It learns whether someone is another player, never their name.' : ' It also sees the names of other players in these events.'}`,
            mono: families,
        });
    }
    if (g.clipboard.length > 0) {
        out.push({ kind: 'clipboard', title: 'Read the clipboard when you turn it on', detail: 'The plugin sees what you copy, only while you have clipboard watching on. The host shows an indicator.', mono: [] });
    }
    // The windows lines: a plugin that sees window titles also sees character names, which is only safe while it cannot send anything out.
    const namesFact = sendsOut ? '' : ' It also sees character names from window titles.';
    const f = g.flags;
    if (f.windowThumbnails) {
        out.push({ kind: 'windowThumbnails', title: 'See your EVE windows', detail: `The plugin sees a live picture of your EVE windows.${namesFact}`, mono: [] });
    }
    // One row of the whole grant carries the names fact: thumbnails, else overlays, else hotkeys (the row may be in the other list of a prompt).
    const namesOn = wf.windowThumbnails ? undefined : wf.overlays ? 'overlays' : wf.hotkeys ? 'hotkeys' : wf.windows ? 'windows' : undefined;
    if (f.windows) {
        out.push({ kind: 'windows', title: 'See your EVE window list', detail: `The plugin sees which EVE windows are open and which one is active. It sees no picture of them.${namesOn === 'windows' ? namesFact : ''}`, mono: [] });
    }
    if (f.overlays) {
        out.push({ kind: 'overlays', title: 'Draw windows over the game', detail: `The plugin shows its own windows above your game.${namesOn === 'overlays' ? namesFact : ''}`, mono: [] });
    }
    if (f.hotkeys) {
        out.push({ kind: 'hotkeys', title: 'Use global hotkeys', detail: `The plugin reacts to key combinations even while another window has focus.${namesOn === 'hotkeys' ? namesFact : ''}`, mono: [] });
    }
    if (f.notifications) {
        out.push({ kind: 'notifications', title: 'Show notifications', detail: 'The plugin can show you notifications. They are shown by the host and always say which plugin sent them.', mono: [] });
    }
    if (f.ai) {
        out.push({ kind: 'ai', title: 'Use your AI provider', detail: 'The plugin can send text to the AI provider you choose in Settings > AI, and that provider sees it. You can cap how many tokens it uses each month.', mono: [] });
    }
    if (f.account) {
        out.push({ kind: 'account', title: 'Use your EVE-Cyno account', detail: 'The plugin can act on your EVE-Cyno account, and the service sees what it sends.', mono: [] });
    }
    if (f.files) {
        // P3: a file the user picks is not a way out (canSendOut ignores `files`), so a plugin that sees names keeps them; the line says a saved
        // file can hold them. HT-M2 (owner decision 2026-11-06): the clause names every source `couldSeeNames` counts (reset.ts), each only while nothing can leave.
        const saved = sendsOut ? [] : [
            ...(wf.windowThumbnails || wf.overlays || wf.hotkeys || wf.windows ? ['your character names'] : []),
            ...(whole.gameEvents.length > 0 ? ['the names of other players'] : []),
            ...(whole.logs.includes('chatlogs') ? ['the chat lines it reads'] : []),
        ];
        out.push({
            kind: 'files', title: 'Save and open files you pick',
            detail: `The plugin can ask you to pick a file to save to or open. It never learns where the file is.${saved.length > 0 ? ` What it saves can include ${listed(saved)}.` : ''}`, mono: [],
        });
    }
    // API 1.14.0: the engine runs on this computer and the namespace makes no network call; `canSendOut` ignores it.
    if (f.fit) {
        out.push({ kind: 'fit', title: 'Use the fitting engine', detail: 'Uses the fitting engine on this computer. Nothing leaves the computer.', mono: [] });
    }
    if (g.storageMB > manifest_1.DEFAULT_STORAGE_MB) {
        out.push({ kind: 'storage', title: `Store up to ${(0, numfmt_gen_1.thousands)(g.storageMB)} MB`, detail: `The plugin keeps up to ${(0, numfmt_gen_1.thousands)(g.storageMB)} MB of its own data on this computer.`, mono: [] });
    }
    // API 1.12.0: copy in the existing row template (the `server` icon of `storage`); only a built-in plugin is ever asked (grants.ts `requested`). Asked at every raise, and shown at the first request.
    if (g.databaseMB > 0) {
        out.push({ kind: 'database', title: `Keep a database of up to ${(0, numfmt_gen_1.thousands)(g.databaseMB)} MB`, detail: `The plugin keeps up to ${(0, numfmt_gen_1.thousands)(g.databaseMB)} MB of data in its own database on this computer.`, mono: [] });
    }
    if (ctx.background)
        out.push((0, exports.backgroundLine)());
    return out;
}
/**
 * The short tags of a Marketplace card (the round 4 boards: "all characters", "9 scopes", "2 hosts", "logs"): one per kind the grant holds,
 * a count where the kind has several, in permLines' order. Nothing granted gives no tag.
 */
function permTags(g) {
    const out = [];
    if (g.characters === 'all')
        out.push('all characters');
    else if (g.characters === 'selected')
        out.push('characters');
    if (g.esi.length > 0)
        out.push(plural(g.esi.length, 'scope', 'scopes'));
    if (g.network.length > 0)
        out.push(plural(g.network.length, 'host', 'hosts'));
    const services = Object.keys(g.services).length;
    if (services > 0)
        out.push(plural(services, 'service', 'services'));
    if (g.logs.length > 0)
        out.push('logs');
    if (g.gameEvents.length > 0)
        out.push('game events');
    if (g.clipboard.length > 0)
        out.push('clipboard');
    const f = g.flags;
    if (f.windowThumbnails || f.windows)
        out.push('windows');
    if (f.overlays)
        out.push('overlays');
    if (f.hotkeys)
        out.push('hotkeys');
    if (f.notifications)
        out.push('notifications');
    if (f.ai)
        out.push('AI');
    if (f.account)
        out.push('account');
    if (f.files)
        out.push('files');
    if (f.fit)
        out.push('fitting engine');
    if (g.storageMB > manifest_1.DEFAULT_STORAGE_MB)
        out.push(`${(0, numfmt_gen_1.thousands)(g.storageMB)} MB`);
    if (g.databaseMB > 0)
        out.push(`${(0, numfmt_gen_1.thousands)(g.databaseMB)} MB database`);
    return out;
}
/** The longest plugin name the host puts in a line of its own words ("Asked by <name>."): 40 characters, then an ellipsis (2026-11-10). */
exports.NAME_CAP = 40;
/** A plugin's name as one line of at most `max` characters (code points): whitespace runs become one space, a longer name is cut and ends with an ellipsis. */
function capName(name, max = exports.NAME_CAP) {
    const one = [...name.replace(/\s+/g, ' ').trim()];
    return one.length <= max ? one.join('') : `${one.slice(0, max - 1).join('').trimEnd()}\u2026`;
}
/**
 * The first-run wizard's plugin row says "Nothing required" (not "Asks for nothing") when the plugin has no required line but has optional items (2026-11-10);
 * a plugin with no items at all keeps "Asks for nothing".
 */
function optionalOnly(lines, optionalCount) {
    return lines.length === 0 && optionalCount > 0;
}
/** The `.sum` text of the badge list: the titles joined with " · ". */
function permSummary(lines) {
    return lines.map(l => l.title).join(' · ');
}
