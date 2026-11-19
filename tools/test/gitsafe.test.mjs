// GS-*: tools/lib/gitsafe.mjs, how the gates run git (merge-scope, base-tree, check-envs, vendor-host): replace refs off, and none of
// the variables that point git at another repository, object store, index or work tree than the one `-C` names. No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { REDIRECTS, gitArgs, gitEnv } from '../lib/gitsafe.mjs';

describe('git as the gates run it', () => {
  test('GS-env: every redirecting variable is dropped, replace refs are off, the rest is kept and the input is not changed', () => {
    const input = { PATH: '/usr/bin', HOME: '/home/x', GH_TOKEN: 'kept', GIT_CONFIG_GLOBAL: '/dev/null' };
    for (const k of REDIRECTS) input[k] = `/elsewhere/${k}`;
    const before = { ...input };
    const out = gitEnv(input);
    assert.deepEqual(input, before, 'the caller\'s environment is not changed');
    for (const k of REDIRECTS) assert.equal(Object.hasOwn(out, k), false, k);
    assert.equal(out.GIT_NO_REPLACE_OBJECTS, '1');
    assert.deepEqual({ PATH: out.PATH, HOME: out.HOME, GH_TOKEN: out.GH_TOKEN, GIT_CONFIG_GLOBAL: out.GIT_CONFIG_GLOBAL },
      { PATH: '/usr/bin', HOME: '/home/x', GH_TOKEN: 'kept', GIT_CONFIG_GLOBAL: '/dev/null' });
  });

  test('GS-redirects: the list names the variables that move the repository, its objects, index or work tree, and the replace refs', () => {
    assert.deepEqual([...REDIRECTS].sort(), ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE',
      'GIT_OBJECT_DIRECTORY', 'GIT_REPLACE_REF_BASE', 'GIT_WORK_TREE']);
  });

  test('GS-args: --no-replace-objects comes before -C and the command', () => {
    assert.deepEqual(gitArgs('/repo', ['cat-file', '-t', 'x']), ['--no-replace-objects', '-C', '/repo', 'cat-file', '-t', 'x']);
  });
});
