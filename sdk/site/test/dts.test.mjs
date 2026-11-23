import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assignDeclarations, docText, firstSentence, interfaceMembers, namespacesOf, parseDts, referencedNames } from '../lib/dts.mjs';

const VENDORED = new URL('../../vendor/plugin-api/1.30.0.d.ts', import.meta.url);
const SAMPLE = `/** Codes. */
export type Code = 'a' | 'b';
export interface Item {
    id: number;
}
/** The things {braces} in a comment do not count. */
export interface ANamespace {
    /** Reads one. */
    get(params: {
        key: string;
        kind: 'x{y';
    }): Promise<Item>;
    keys(): Promise<Code[]>;
    onChange?(handler: () => void): () => void;
}
export interface BNamespace {
    list(): Promise<Item[]>;
}
export type Reserved = Record<string, never>;
export interface EveCyno {
    a: ANamespace;
    /** 1.1.0. */
    b?: BNamespace;
    account?: Reserved;
}
export declare function getEveCyno(): EveCyno;
`;

test('parseDts: names, kinds, exact text, docs', () => {
  const d = parseDts(SAMPLE);
  assert.deepEqual(d.map((x) => `${x.kind}:${x.name}`), ['type:Code', 'interface:Item', 'interface:ANamespace', 'interface:BNamespace', 'type:Reserved', 'interface:EveCyno', 'function:getEveCyno']);
  assert.equal(d[0].doc, 'Codes.');
  assert.equal(d[0].text, "/** Codes. */\nexport type Code = 'a' | 'b';");
  assert.ok(SAMPLE.includes(d[2].text));
  assert.match(d[2].docRaw, /\{braces\}/);
});

test('interfaceMembers: multi-line signatures and docs', () => {
  const a = parseDts(SAMPLE).find((x) => x.name === 'ANamespace');
  const m = interfaceMembers(a);
  assert.deepEqual(m.map((x) => [x.name, x.optional]), [['get', false], ['keys', false], ['onChange', true]]);
  assert.equal(m[0].doc, 'Reads one.');
  assert.match(m[0].signature, /kind: 'x\{y';\n\s+\}\): Promise<Item>$/);
});

test('namespacesOf and assignDeclarations: each declaration on exactly one page', () => {
  const d = parseDts(SAMPLE);
  const ns = namespacesOf(d);
  assert.deepEqual(ns.map((n) => [n.name, n.type, n.optional, n.reserved]), [['a', 'ANamespace', false, false], ['b', 'BNamespace', true, false], ['account', 'Reserved', true, true]]);
  const pages = assignDeclarations(d);
  const where = (name) => [...pages].find(([, list]) => list.some((x) => x.name === name))?.[0];
  assert.equal(where('ANamespace'), 'api/a');
  assert.equal(where('Code'), 'api/a'); // only ANamespace names it
  assert.equal(where('Item'), 'api/types'); // ANamespace and BNamespace both name it
  assert.equal(where('EveCyno'), 'api');
  assert.equal(where('Reserved'), 'api');
  assert.equal(where('getEveCyno'), 'api');
  assert.equal([...pages.values()].flat().length, d.length);
});

test('referencedNames ignores comments and strings', () => {
  const d = parseDts('export interface X {\n    /** Uses Y in prose. */\n    a: Z;\n    b: \'Y\';\n}\nexport type Y = 1;\nexport type Z = 2;');
  const x = d.find((e) => e.name === 'X');
  assert.deepEqual([...referencedNames(x, new Set(d.map((e) => e.name)))], ['Z']);
});

test('docText and firstSentence', () => {
  assert.equal(docText('/**\n * One. Two.\n * Three.\n */'), 'One. Two.\nThree.');
  assert.equal(firstSentence('One. Two.\nThree.'), 'One.');
  assert.equal(firstSentence('no stop'), 'no stop');
});

test('the vendored 1.29.0 declarations: every export is read, once, on one page', () => {
  const source = readFileSync(VENDORED, 'utf8');
  const exported = source.split('\n').filter((l) => /^export /.test(l));
  const d = parseDts(source);
  assert.equal(d.length, exported.length);
  assert.equal(new Set(d.map((x) => x.name)).size, d.length);
  for (const x of d) assert.ok(source.includes(x.text), `${x.name} text is the source text`);
  const pages = assignDeclarations(d);
  assert.equal([...pages.values()].flat().length, d.length);
  const names = [...pages.values()].flat().map((x) => x.name).sort();
  assert.deepEqual(names, d.map((x) => x.name).sort());
});

test('the vendored EveCyno namespaces: 8 always present, 19 optional, account reserved', () => {
  const ns = namespacesOf(parseDts(readFileSync(VENDORED, 'utf8')));
  assert.equal(ns.filter((n) => !n.optional).length, 8);
  assert.equal(ns.filter((n) => n.optional && !n.reserved).length, 19);
  assert.deepEqual(ns.filter((n) => n.reserved).map((n) => n.name), ['account']);
  assert.deepEqual(ns.slice(0, 3).map((n) => n.name), ['host', 'storage', 'commands']);
});
