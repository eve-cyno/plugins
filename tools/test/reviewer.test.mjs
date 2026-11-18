// Tests of tools/lib/reviewer.mjs: the environments' only required reviewer is read from GitHub's answer for
// GET /repos/eve-cyno/plugins/environments/<name>, never from a file of the repository; every other shape of the answer fails closed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, describe, test } from 'node:test';
import { readReviewer, reviewerOf } from '../lib/reviewer.mjs';
import { REVIEWER, envDoc, makeGhStub, stubEnv, userReviewer } from './ghstub.mjs';

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const BIN = makeGhStub(temps);
const R = 'repos/eve-cyno/plugins';

describe('reviewer from the environment', () => {
  test('RV-one-user: the one User of the one required_reviewers rule is the reviewer', () => {
    assert.deepEqual(reviewerOf(envDoc('index')), { id: REVIEWER.id, login: REVIEWER.login });
  });
  test('RV-shape: any other shape fails closed', () => {
    const cases = [
      [null, /not an object/],
      [[], /not an object/],
      [{ ...envDoc('index'), protection_rules: undefined }, /protection_rules is missing/],
      [envDoc('index', { rules: [{ id: 12, type: 'branch_policy' }] }), /0 required_reviewers rules/],
      [envDoc('index', { rules: [envDoc('index').protection_rules[0], envDoc('index').protection_rules[0]] }), /2 required_reviewers rules/],
      [envDoc('index', { reviewers: [] }), /0 required reviewers/],
      [envDoc('index', { reviewers: [userReviewer(REVIEWER.id, REVIEWER.login), userReviewer(777)] }), /2 required reviewers/],
      [envDoc('index', { reviewers: [{ type: 'Team', reviewer: { id: 5, slug: 'maintainers' } }] }), /a Team, not a User/],
      [envDoc('index', { reviewers: [{ type: 'User' }] }), /no numeric user id/],
      [envDoc('index', { reviewers: [userReviewer('987654', REVIEWER.login)] }), /no numeric user id/],
      [envDoc('index', { reviewers: [userReviewer(0, REVIEWER.login)] }), /no numeric user id/],
      [envDoc('index', { reviewers: [{ type: 'User', reviewer: { id: REVIEWER.id } }] }), /no valid login/],
      [envDoc('index', { reviewers: [userReviewer(REVIEWER.id, '-bad-')] }), /no valid login/],
      [envDoc('index', { reviewers: [userReviewer(REVIEWER.id, 'a b')] }), /no valid login/],
    ];
    for (const [doc, re] of cases) {
      const r = reviewerOf(doc);
      assert.ok(r.error, JSON.stringify(doc));
      assert.match(r.error, re);
      assert.doesNotMatch(r.error, new RegExp(`${REVIEWER.login}|${REVIEWER.id}`), 'an error never names the login or the id');
    }
  });
  test('RV-read: readReviewer asks GET .../environments/<name> and nothing else', async () => {
    const { env, log } = stubEnv(BIN, { [`GET ${R}/environments/mirror`]: { stdout: envDoc('mirror') } }, temps);
    const r = await readReviewer('mirror', { env });
    assert.equal(r.id, REVIEWER.id);
    assert.equal(r.login, REVIEWER.login);
    assert.equal(r.doc.name, 'mirror');
    assert.deepEqual(log().map((a) => a[a.length - 1]), [`${R}/environments/mirror`]);
  });
  test('RV-read-fails-closed: a failed request or a bad answer is an error, never a guessed reviewer', async () => {
    const { env } = stubEnv(BIN, {
      [`GET ${R}/environments/index`]: { stdout: '{"message":"Not Found"}', exit: 1, stderr: 'gh: Not Found (HTTP 404)\n' },
      [`GET ${R}/environments/mirror`]: { stdout: envDoc('mirror', { reviewers: [] }) },
    }, temps);
    assert.match((await readReviewer('index', { env })).error, /environments\/index: gh api exited 1/);
    assert.match((await readReviewer('mirror', { env })).error, /environment mirror: 0 required reviewers/);
    assert.match((await readReviewer('other', { env })).error, /not index or mirror/);
  });
});
