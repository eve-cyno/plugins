// git as the gates run it (tools/merge-scope.mjs, tools/lib/basetree.mjs, tools/check-envs.mjs, tools/vendor-host.mjs): on the
// objects named, in the repository named. Two things make git read something else. A replace ref (refs/replace/<oid>, or the
// namespace GIT_REPLACE_REF_BASE names) shows another commit, tree or blob in place of the one named to every command not run with
// --no-replace-objects. And the variables of REDIRECTS point git at another repository, object store, index or work tree than the
// one `git -C <dir>` names.
//
// Threat model (docs/RUNBOOK.md "Roles"). The attacker is a pull request author, anyone who can push to a pull request branch, or
// the author of a desktop commit that is not on desktop main. Trusted: the coordinator's workstation, its environment, git config,
// hooks, every `.git` directory (info/grafts, shallow, local refs), the trusted worktree, and GitHub's view of main. Out of scope:
// anything that needs write access on the workstation or control of the caller's environment (GIT_GRAFT_FILE, info/grafts,
// GIT_SHALLOW_FILE, GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT, git config, hooks, local replace refs). REDIRECTS and the replace
// refs switch below are hardening kept on top of that, not a defence against the caller's environment.

/** The variables that move git away from the repository `-C` names, or that pick the replace refs. */
export const REDIRECTS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE',
]);

/** A copy of `env` without REDIRECTS and with replace refs off for every git that git starts (GIT_NO_REPLACE_OBJECTS). */
export function gitEnv(env) {
  const out = { ...env, GIT_NO_REPLACE_OBJECTS: '1' };
  for (const k of REDIRECTS) delete out[k];
  return out;
}

/** The argument list of `git <args>` in the repository `dir`, with replace refs off. */
export const gitArgs = (dir, args) => ['--no-replace-objects', '-C', dir, ...args];
