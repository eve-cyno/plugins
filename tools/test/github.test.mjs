// Tests of tools/lib/github.mjs against the stub gh (ghstub.mjs): the fixed host argument, the fail-closed list reader and the
// parser of `gh api -i` answers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, describe, test } from 'node:test';
import { getAll, getJson, oneLine, parseHttp, printableLine } from '../lib/github.mjs';
import { makeGhStub, stubEnv } from './ghstub.mjs';

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const BIN = makeGhStub(temps);
const E = 'repos/eve-cyno/plugins/x?per_page=100';
const pages = async (stdout) => {
  const { env, log } = stubEnv(BIN, { [`GET ${E}`]: { stdout } }, temps);
  return { ...(await getAll(E, 'items', { env })), calls: log() };
};

describe('github.mjs', () => {
  test('GH-all: every page, with --paginate --slurp and the host as an argument', async () => {
    const r = await pages([{ total_count: 3, items: [{ id: 1 }, { id: 2 }] }, { total_count: 3, items: [{ id: 3 }] }]);
    assert.deepEqual(r.items.map((x) => x.id), [1, 2, 3]);
    for (const a of ['--paginate', '--slurp', '--hostname=github.com', '--method=GET']) assert.ok(r.calls[0].includes(a), a);
  });
  test('GH-all-disagree: pages that disagree on total_count fail', async () => {
    assert.match((await pages([{ total_count: 3, items: [{ id: 1 }, { id: 2 }] }, { total_count: 2, items: [{ id: 3 }] }])).error, /disagree.*incomplete/);
  });
  test('GH-all-twice: an item read twice fails', async () => {
    assert.match((await pages([{ total_count: 2, items: [{ id: 1 }] }, { total_count: 2, items: [{ id: 1 }] }])).error, /read twice/);
  });
  test('GH-all-short: fewer items than total_count fail', async () => {
    assert.match((await pages([{ total_count: 3, items: [{ id: 1 }] }])).error, /1 of 3 items read; the list is incomplete/);
  });
  test('GH-all-shape: a page of another shape, no pages, or not JSON fails', async () => {
    assert.match((await pages([{ total_count: 1, other: [] }])).error, /a page is not/);
    assert.match((await pages([])).error, /no pages/);
    assert.match((await pages('not json')).error, /not one JSON value/);
  });
  test('GH-json-exit: a non-zero exit is an error even with a JSON body', async () => {
    const { env } = stubEnv(BIN, { 'GET user': { stdout: { id: 1 }, exit: 1, stderr: 'gh: Bad credentials (HTTP 401)\n' } }, temps);
    assert.match((await getJson('user', { env })).error, /^user: gh api exited 1: gh: Bad credentials/);
  });
  test('GH-no-gh: no gh on PATH is an error, not a throw', async () => {
    assert.match((await getJson('user', { env: { PATH: '/nonexistent' } })).error, /gh not found/);
  });
  test('GH-http: one answer parses; a missing blank line, a nameless header or a second answer fails', () => {
    const r = parseHttp('HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 9\r\nX-A: 1\r\nx-a: 2\r\n\r\n{"message":"m"}');
    assert.equal(r.status, 403);
    assert.deepEqual(r.headers.get('x-ratelimit-remaining'), ['9']);
    assert.deepEqual(r.headers.get('x-a'), ['1', '2']);
    assert.deepEqual(r.body, { message: 'm' });
    assert.match(parseHttp('HTTP/2.0 403 Forbidden\r\nX: 1').error, /no blank line/);
    assert.match(parseHttp('HTTP/2.0 403 Forbidden\r\nnocolon\r\n\r\n{}').error, /without a name/);
    assert.match(parseHttp('HTTP/2.0 403 Forbidden\r\n: 1\r\n\r\n{}').error, /without a name/);
    assert.match(parseHttp('HTTP/2.0 403 Forbidden\r\n\r\n\r\nHTTP/2.0 200 OK\r\n\r\n[]').error, /more than one/);
    assert.match(parseHttp('HTTP/2.0 403 Forbidden\r\n\r\n{}\r\n\r\nHTTP/2.0 200 OK\r\n\r\n[]').error, /more than one/);
    assert.match(parseHttp('garbage\r\n\r\n{}').error, /not an HTTP status line/);
    assert.equal(parseHttp('HTTP/2.0 403 Forbidden\r\n\r\nnot json').body, null);
  });
  test('GH-printable: one printable line with no "##[" anywhere (the runner\'s older command form, found anywhere in a line); "::" stays on its line', () => {
    for (const s of ['a ##[error]x', '###[warning]y', '##[##[z', '#\n#[add-mask]w', '##[set-output name=a;]b ##[error]c']) {
      assert.ok(!printableLine(s).includes('##['), `${JSON.stringify(s)} -> ${JSON.stringify(printableLine(s))}`);
      assert.ok(!oneLine(s).includes('##['), JSON.stringify(s));
    }
    assert.equal(printableLine('a ##[error]x'), 'a # #[error]x');
    assert.equal(printableLine('x\n::error::y\r\n::warning::z'), 'x ::error::y ::warning::z');
    assert.equal(printableLine('  #[ok] # [ok] ## [ok]  '), '#[ok] # [ok] ## [ok]');
    const long = oneLine(`${'#'.repeat(299)}[error]`);
    assert.ok(long.length <= 300 && !long.includes('##['), long);
  });
});
