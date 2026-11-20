#!/usr/bin/env node
// create-plugin [dir] [--id <id>] [--name <name>] [--author <a>] [--description <d>] [--yes] [--version] [--help]
// Exit codes: 0 done, 1 refused (nothing written), 2 usage error.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { GenerateError, PACKAGE, lastSegment, titleCase, writeProject } from '../lib/generate.mjs';

const HELP = `Usage: create-plugin [dir] [--id <id>] [--name <name>] [--author <author>] [--description <text>] [--yes]

Generates an EVE-Cyno desktop plugin project in dir (default: the last segment of the id). It asks for what is missing unless --yes is given.
  --id           plugin id: three or more lower-case dotted words, for example com.example.my-plugin
  --name         display name, at most 60 characters (default with --yes: the last id segment in title case)
  --author       author shown in the Marketplace, at most 60 characters
  --description  one line, at most 120 characters (default: A plugin for the EVE-Cyno desktop app.)
  --yes          do not ask; --id and --author are then required
  --version      print the scaffold version and the plugin API version it bundles
`;
const FLAGS = new Map([['--id', 'id'], ['--name', 'name'], ['--author', 'author'], ['--description', 'description']]);

function usage(message) {
  process.stderr.write(`create-plugin: ${message}\n\n${HELP}`);
  process.exit(2);
}

function parse(argv) {
  const out = { answers: {}, dir: undefined, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { process.stdout.write(HELP); process.exit(0); }
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(`${PACKAGE.name} ${PACKAGE.version} (plugin API ${PACKAGE.eveCynoApi})\n`);
      process.exit(0);
    }
    if (arg === '--yes' || arg === '-y') { out.yes = true; continue; }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (FLAGS.has(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) usage(`${flag} needs a value`);
      out.answers[FLAGS.get(flag)] = value;
    } else if (arg.startsWith('-')) usage(`unknown option ${arg}`);
    else if (out.dir === undefined) out.dir = arg;
    else usage(`unexpected argument ${arg}`);
  }
  return out;
}

// One question at a time from stdin, so a piped answer list works as well as a terminal.
function asker() {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const lines = [];
  const waiting = [];
  let closed = false;
  rl.on('line', l => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(''); });
  return {
    ask(question) {
      process.stderr.write(question);
      if (lines.length) return Promise.resolve(lines.shift());
      if (closed) return Promise.resolve('');
      return new Promise(r => waiting.push(r));
    },
    close: () => rl.close(),
  };
}

async function main() {
  const { answers, dir: given, yes } = parse(process.argv.slice(2));
  if (yes) {
    for (const f of ['id', 'author']) if (!answers[f]) usage(`--yes needs --${f}`);
  } else {
    const q = asker();
    if (!answers.id) answers.id = (await q.ask('Plugin id (for example com.example.my-plugin): ')).trim();
    const fallbackName = answers.id ? titleCase(lastSegment(answers.id)) : '';
    if (!answers.name) answers.name = (await q.ask(`Display name [${fallbackName}]: `)).trim() || fallbackName;
    if (!answers.author) answers.author = (await q.ask('Author: ')).trim();
    if (!answers.description) answers.description = (await q.ask('One-line description [A plugin for the EVE-Cyno desktop app.]: ')).trim();
    q.close();
  }
  answers.name ??= answers.id ? titleCase(lastSegment(answers.id)) : '';
  answers.description ||= 'A plugin for the EVE-Cyno desktop app.';
  const dir = resolve(given ?? (answers.id ? lastSegment(answers.id) : '.'));
  try {
    const written = writeProject(dir, answers);
    process.stdout.write(`Created ${written.length} files in ${dir}\nNext: cd ${given ?? lastSegment(answers.id)} && npm install && npm run build\n`);
  } catch (e) {
    if (!(e instanceof GenerateError)) throw e;
    process.stderr.write(`create-plugin: nothing written\n${e.problems.map(p => `  ${p}`).join('\n')}\n`);
    process.exit(1);
  }
}

main();
