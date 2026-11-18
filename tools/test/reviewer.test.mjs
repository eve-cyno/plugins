// Tests of tools/lib/reviewer.mjs: the reviewer file is exactly {"reviewerId": <positive integer>}, the committed placeholder is
// refused, and the file is read at the given commit, never at HEAD or in the working tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseReviewer, readReviewerAt, readReviewerFile } from '../lib/reviewer.mjs';
import { repoWithReviewer } from './ghstub.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

describe('reviewer file', () => {
  test('RV-shape: only {"reviewerId": <positive safe integer>} is an id', () => {
    assert.deepEqual(parseReviewer('{"reviewerId": 4242}'), { id: 4242 });
    for (const bad of ['{"reviewerId": 0}', '{"reviewerId": -1}', '{"reviewerId": 1.5}', '{"reviewerId": "4242"}', '{"reviewerId": 9007199254740993}',
      '{"reviewerId": 4242, "x": 1}', '{"id": 4242}', '[4242]', '4242', 'null', '{']) {
      assert.ok(parseReviewer(bad).error, bad);
    }
  });
  test('RV-placeholder: the committed placeholder is refused by name', () => {
    assert.match(parseReviewer('{"reviewerId": 4242, "placeholder": "x"}').error, /placeholder/);
    assert.match(readReviewerFile(ROOT).error ?? 'a real id is committed', /placeholder|a real id is committed/);
  });
  test('RV-at-rev: the file is read at the commit given, not at HEAD and not in the working tree', async () => {
    const repo = repoWithReviewer('{"reviewerId": 4242}', '{"reviewerId": 777}', temps);
    assert.deepEqual(await readReviewerAt(repo.dir, repo.rev, process.env), { id: 4242 });
    assert.match((await readReviewerAt(repo.dir, 'HEAD', process.env)).error, /40 lower-case hex/);
    assert.match((await readReviewerAt(repo.dir, repo.rev.toUpperCase(), process.env)).error, /40 lower-case hex/);
    assert.match((await readReviewerAt(repo.dir, repo.rev)).error, /no environment/);
  });
  test('RV-git-dir-ignored: GIT_DIR in the environment does not redirect the read', async () => {
    const repo = repoWithReviewer('{"reviewerId": 4242}', undefined, temps);
    const other = repoWithReviewer('{"reviewerId": 777}', undefined, temps);
    assert.deepEqual(await readReviewerAt(repo.dir, repo.rev, { ...process.env, GIT_DIR: path.join(other.dir, '.git') }), { id: 4242 });
  });
});
