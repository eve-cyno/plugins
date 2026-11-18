// tools/lib/reviewer.mjs: the only required reviewer of the environments index and mirror (plan 4.1 "One account", 4.2 "The
// reviewer in code"). No login or user id is written in the repository: the reviewer is read at run time from GitHub's answer for
// GET /repos/eve-cyno/plugins/environments/<name>, its one required_reviewers rule. This module reads nothing else, no file, no
// environment variable and no argument (static rule C-WF11), and it never prints the login or the id: its errors name neither.
import { REPO, getJson, oneLine } from './github.mjs';

/** A GitHub login: 1 to 39 letters, digits and single inner hyphens. */
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * { id, login } of the one required reviewer that an environment answer names, or { error }. Fails closed: no rule, two rules, no
 * reviewer, two reviewers, a team, or a user without a numeric id or a valid login is an error, never a guess.
 */
export function reviewerOf(doc) {
  if (!isObj(doc)) return { error: 'the environment answer is not an object' };
  if (!Array.isArray(doc.protection_rules)) return { error: 'protection_rules is missing' };
  const rules = doc.protection_rules.filter((r) => isObj(r) && r.type === 'required_reviewers');
  if (rules.length !== 1) return { error: `${rules.length} required_reviewers rules, expected exactly 1` };
  const list = Array.isArray(rules[0].reviewers) ? rules[0].reviewers : [];
  if (list.length !== 1) return { error: `${list.length} required reviewers, expected exactly 1` };
  const one = list[0];
  if (!isObj(one) || one.type !== 'User') return { error: `the required reviewer is a ${oneLine(isObj(one) ? one.type : typeof one)}, not a User` };
  const user = one.reviewer;
  if (!isObj(user) || !Number.isSafeInteger(user.id) || user.id <= 0) return { error: 'the required reviewer has no numeric user id' };
  if (typeof user.login !== 'string' || !LOGIN_RE.test(user.login)) return { error: 'the required reviewer has no valid login' };
  return { id: user.id, login: user.login };
}

/** { id, login, doc } for the environment `name` (index or mirror) of eve-cyno/plugins, read now, or { error }. Never rejects. */
export async function readReviewer(name, opts) {
  if (name !== 'index' && name !== 'mirror') return { error: `environment ${oneLine(name)} is not index or mirror` };
  const r = await getJson(`repos/${REPO}/environments/${name}`, opts);
  if (r.error) return { error: r.error };
  const who = reviewerOf(r.value);
  return who.error ? { error: `environment ${name}: ${who.error}` } : { ...who, doc: r.value };
}
