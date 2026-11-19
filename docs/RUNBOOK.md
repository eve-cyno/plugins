# Runbook: publishing the plugin index

How the index at `plugins.eve-cyno.dev` is published, re-signed, revoked and repaired, and what must be true before anyone approves a
run. The workflows are `.github/workflows/publish.yml`, `resign.yml` and `check.yml`; `tools/test/workflows.test.mjs` holds their
rules (C-WF1 to C-WF12).

Roles:

- **The owner** (his own GitHub account) merges, dispatches runs, and is the **only required reviewer** of the environments `index`
  and `mirror`. He reviews every merge: no pull request is merged before he has said "merge" for its head commit (all 40 hex
  digits of it, "Publishing" step 1.4a), an entries-only
  one included (owner ruling of 2026-11-19, SA-2 of the stage-fixes plan); the coordinator then makes the local merge and the push
  of "Publishing" step 1, and `tools/merge-scope.mjs` decides how much of the pull request he reads first. He approves only from
  GitHub Mobile, after the steps in "Before every index and mirror approval".
- **The coordinator** (an agent) runs `tools/check-envs.mjs`, `tools/approved-base.mjs`, `tools/merge-scope.mjs`,
  `tools/check-workflows.mjs` and local verifications, always from the trusted worktree (below), and hands their output to the owner.
  It never merges a pull request the owner has not said "merge" for, whatever the tools print. It sets secrets only with the
  commands of "Secrets and variables", which move each value on stdin and print none. It never approves a deployment, never
  dispatches `publish.yml` with `target: production`, and never reads a secret's value.
- **Agents** work with the agents' token (below). It cannot approve a deployment, dispatch a run, change an environment's protection
  rules, or delete runs or artifacts. It can write secrets and environment variables (owner decision 2026-11-18; "One account" names
  what that allows). Agents push over SSH.

**Threat model.** The gates of this runbook defend against a pull request's author, anyone who can push to a pull request branch,
and the author of a desktop commit that is not on desktop `main`. Trusted: the coordinator's workstation, its environment, git
config, hooks, every `.git` directory (`info/grafts`, `shallow`, local refs), the trusted worktree, and GitHub's view of `main`. Out
of scope: anything that needs write access on the workstation or control of the caller's environment. So the tools do not guard
against `GIT_GRAFT_FILE` or `info/grafts`, `GIT_SHALLOW_FILE`, `GIT_CONFIG_PARAMETERS` or `GIT_CONFIG_COUNT`, git config, hooks,
local replace refs, or the index that `tools/check.mjs` lists with `git ls-files` in a checkout; the variables that
`tools/lib/gitsafe.mjs` removes and its replace refs switch stay as hardening.

**The trusted worktree.** A pull request or a run's commit can change the tools themselves, so a tool run from the checkout under
review prints whatever that change wants (a `tools/check.mjs` that never names `maintenance`, say). The coordinator therefore runs
every `node` command of this runbook that a merge or an approval rests on from `../eve-cyno-plugins-trusted`, a worktree beside
its checkout at a commit whose code the owner has read: `<A>` (step 2 of "Before every index and mirror approval"), or, until the
first production run whose `sign` and `upload` succeeded, `<X>`, the commit of the newest `read in full <X> <date>` line of his
list ("Owner steps before the first production publish", step 0, which comes before the first merge and the first tool run). The
commands are written for a shell in `<checkout>`: `node ../eve-cyno-plugins-trusted/tools/...` runs the trusted copy, and the
checkout under review is only ever named as `--repo-dir`, `--dir` or `--repo`, never run. The worktree has its own
`npm ci --ignore-scripts` and is never edited. It moves only to a commit the owner has read: never to the commit under review while
he reads it (the vendor check of "Owner steps before the first production publish", step 0.2, reads that commit's tree from the
unmoved worktree). To set it up at `<X>`, to move it to a later commit read in full once its `read in full` line is written (step 4
of "Before every index and mirror approval"), and to move it after each production run whose `sign` and `upload` succeeded and
which the owner entered in his list (that run's commit is the next `<A>`):

```
git -C <checkout> worktree add --detach ../eve-cyno-plugins-trusted <X>   # once
git -C ../eve-cyno-plugins-trusted checkout -q --detach <commit>          # each later move
(cd ../eve-cyno-plugins-trusted && npm ci --ignore-scripts)               # after the owner read package.json and the lock there
git -C ../eve-cyno-plugins-trusted rev-parse HEAD                         # must print that commit
git -C ../eve-cyno-plugins-trusted status --porcelain                     # must print nothing
```

**Hard rule.** No private key, passphrase or token is ever put in an argument list, an output, a file an agent writes, a log or a
message. The commands of "Secrets and variables" move each value on stdin only. This is a rule of conduct, not a barrier: "One
account" names what any process of the agents' user can still do with the keys.

**The owner never runs a decrypt command.** Every command below that decrypts a backup is run by the coordinator; the owner only
types a value into a password dialog that a command opens. The key backup opens only with a passphrase-protected age identity: its
passphrase goes into one password window per run, and only into a window whose title names the script and the operation that the
coordinator announced first, for an operation the owner asked for in this session. Any other window: Cancel and report. A passphrase
typed into an unannounced window counts as leaked.

## Secrets and variables

Names only. No value is ever written here or typed into a web page.

| Environment | Kind | Name | Used by |
|---|---|---|---|
| `index` | secret | `MINISIGN_INDEX_KEY` | the `sign` job of `publish.yml` and `resign.yml` |
| `index` | secret | `MINISIGN_INDEX_PASSWORD` | the same job |
| `mirror` | secret | `R2_ACCESS_KEY_ID` | the upload step of the `upload` jobs |
| `mirror` | secret | `R2_SECRET_ACCESS_KEY` | the same step |
| `mirror` | variable | `R2_ACCOUNT_ID` | the same step |
| `mirror` | variable | `R2_BUCKET` (`eve-cyno-plugins`) | the same step |

None of them is a repository or organization secret. The static rule C-WF5 fails if a `MINISIGN_` name appears outside a job with
`environment: index`, or an `R2_` name outside a job with `environment: mirror`.

All six were set on 2026-11-18. To set them, or set them again, the coordinator runs these from a checkout of the infra
repository (`eve-cyno-infra`); the owner only types into the password dialogs of step 2, and nobody pastes a value anywhere:

1. **`index`:** `scripts/desktop-signing-rotate.sh secrets index index --env index --repo eve-cyno/plugins`. It takes the index
   primary from the encrypted backup, proves it against its `.pub` and the key the app pins (key id `F5F7F2E299DF08D4` on
   2026-11-18), and pipes
   the key and its passphrase to `gh secret set` on stdin.
2. **`mirror` secrets:** `scripts/secret-dialog.sh --gh eve-cyno/plugins --env mirror 'R2_ACCESS_KEY_ID:^[0-9a-f]{32}$'
   'R2_SECRET_ACCESS_KEY:^[0-9a-f]{64}$'`. It opens one password dialog per name, the owner types the value of the R2 token made
   for this bucket, and the value goes to `gh secret set` on stdin. A value that does not match its pattern is refused before
   anything is written, and no value is printed.
3. **`mirror` variables:** `R2_ACCOUNT_ID` and `R2_BUCKET` are plain values, not secrets, set with `gh variable set --env mirror
   --repo eve-cyno/plugins`.

After the first head signed here verifies, the two `MINISIGN_INDEX_*` secrets of `eve-cyno/desktop` are deleted with `gh secret
delete`; its `sign.yml` purpose `index` then fails with "a secret of this key is not set" and stays as the emergency path.

## The environments

Both `index` and `mirror` have exactly these settings (created by the coordinator on 2026-11-18):

- **Required reviewers:** one, the owner's own account. **Prevent self-review:** off (`prevent_self_review: false`): the owner both
  dispatches and approves, so with it on GitHub would refuse every approval ("One account" below says what guards instead).
- **Allow administrators to bypass configured protection rules:** off (`can_admins_bypass: false`).
- **Deployment branches and tags:** selected branches, one rule: the branch `main` (not a tag).
- No wait timer and no custom protection rule (`tools/check-envs.mjs` fails on any rule type other than the reviewer and branch rules).

Repository settings (2026-11-18): Actions limited to the selected actions `actions/checkout`, `actions/setup-node`,
`actions/upload-artifact` and `actions/download-artifact`, with SHA pinning required; default workflow permissions read, and
workflows may not approve pull request reviews; fork pull request workflows need approval for all external contributors; a ruleset
on `main` (no deletion, no non-fast-forward, updates restricted; organization admins may bypass). Settings, Actions, General,
"Artifact and log retention" stays at 90 days: the workflows ask for 90 days on the `head`, `signature` and `catalog` artifacts, GitHub
caps every artifact at the repository setting, and recovery R2 needs them.

## One account: who approves, and what stops an agent

The owner decided on 2026-11-18 that his own account is the only reviewer; there is no second account.

- **The owner's login and user id are never written in this repository.** `tools/check-envs.mjs`, `tools/approved-base.mjs` and the
  workflow jobs read the reviewer at run time from `GET /repos/eve-cyno/plugins/environments/<name>` (its one `required_reviewers`
  rule, `tools/lib/reviewer.mjs`); more or fewer than one reviewer fails. The static rule C-WF11 refuses a reviewer file, a reviewer
  input or variable, and a user id or login written as a literal in a workflow or tool; `tools/check-envs.mjs` looks for the real
  login and id in every path, file and commit at the run's commit and fails on any hit. Neither tool prints them.
- **Approvals come only from GitHub Mobile** on the owner's phone: never in a browser on the agents' workstation, never with `gh` or
  the API.
- **Claude in Chrome is blocked on `github.com`** (owner step O1), so no agent can click an approval in the owner's browser session.
- **Why "Prevent self-review" stays off, and what guards instead.** With one account as dispatcher and approver it would block every
  run. The safeguards are: (1) the agents' token cannot approve or change the protection rules (the probes of
  `tools/check-envs.mjs`, plus the empirical check after the token switch, below); (2) the reading before every approval, with
  `tools/approved-base.mjs` and the owner's own list; (3) recovery R2's stop rule for missing artifacts.
- **The agents can write secrets, named honestly.** The agents' token holds Secrets and Environments, read and write, for good
  (owner decision 2026-11-18), so the coordinator sets secrets with the scripted commands and the owner never pastes one. So an
  agent can replace a secret's value (the index key and passphrase, the R2 keys) or an environment variable (`R2_ACCOUNT_ID`,
  `R2_BUCKET`), or delete one. It cannot read a value back (GitHub returns names only), approve a deployment, or change an
  environment's reviewers, branch rule or admin bypass: those need Deployments write or Administration, which the token lacks.
  `tools/check-envs.mjs` checks the protection, and that the token is refused both permissions, before every approval. What a
  replaced value does: an index key other than the pinned one fails the `sign` job's check against
  `vendor/eve-cyno-host/host/src/keys/index.pub`, so nothing is uploaded; other R2 keys or variables fail the upload or put the files
  where `plugins.eve-cyno.dev` does not serve them, which the `verify` job reports as a failure. Both are a failed run, not a
  forged index; the values are then set again with the commands of "Secrets and variables". A replaced value is not visible
  in the run before the approval, but its update time is: C-ENV1 prints `updated_at` for each of the six (`MINISIGN_INDEX_KEY`,
  `MINISIGN_INDEX_PASSWORD`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`), and the reviewer compares
  each with the date the owner or the coordinator set it; a later date that nobody set means no approval. C-ENV1 also checks the
  two variables' values (`R2_BUCKET` is `eve-cyno-plugins`, `R2_ACCOUNT_ID` is 32 lower-case hex; it prints only ok or fail, never
  the value), and fails on any secret or variable named `MINISIGN_*` or `R2_*` at repository or organization level, or in any
  environment other than `index` and `mirror` (it lists the environments, then each other one's secrets and variables): one at
  repository or organization level reaches every job of the repository without an approval of `index` or `mirror`, and one in
  another environment reaches every job that names that environment. It also fails on any secret or variable in `index` or `mirror`
  beyond the six: `index` holds the two `MINISIGN_INDEX_*` secrets and no variable, `mirror` the two `R2_*` secrets and the two `R2_*`
  variables. Each job that names an environment can read all of it once approved. A failure names the extra one, never its value; the
  owner or the coordinator deletes it. A list it cannot read fails closed.
- **The key-custody residual, named exactly.** Since 2026-11-19 the key backup (`signing/desktop/keys.enc.yaml` in the infra
  repository) is encrypted to an age identity of its own, protected by a passphrase that only the owner types, into a window. The
  agents' user can no longer decrypt the backup with the age key it uses for the prod files. What remains: (1) the infra repository's
  git history and every old clone still hold the previous backup, encrypted to the old recipient, so the keys that existed before
  the re-key stay readable with the old identity until they are rotated (planned with the next desktop release; that rotation closes
  this part); (2) the agents' user is the owner's user, so a process of it could show a look-alike window, edit the helper script, or read
  the clipboard or memory while a run holds the identity, then sign a head offline: what stops it is that the owner types only into
  announced windows, and a passphrase typed elsewhere counts as leaked; (3) the identity file can be copied, and its passphrase can
  then be guessed offline, so its strength matters. The infra repository's Cloudflare API token (`cloudflare_api_token`, which
  Terraform uses for the `eve-cyno-plugins` bucket) can still write to the bucket, so write access to the bucket is no barrier: a forged
  index needs the signature, which needs the passphrase, but a stale signed head can be replayed or an index deleted without it
  (availability and rollback, not a forgery). A hardware key for the identity is a later step. The phone approval guards only the CI
  copy of the key. Until the keys have rotated, the hard rule above is a rule of conduct for the agents for those keys, not a barrier.
- **The residual, named honestly.** Agents push to `main` over SSH with the owner's key, and the ruleset lets an organization admin
  bypass it. So an agent can push a changed workflow, tool, `package.json` or lock file. Such a workflow can ask for
  `permissions: actions: write` for its own `GITHUB_TOKEN` and delete runs or artifacts, or it can prepare a run that the owner then
  dispatches and approves under his own identity: GitHub cannot tell the owner's action from an agent's suggestion, and self-review
  prevention is off. **Only the reading before every approval catches this**: `<A>` from `tools/approved-base.mjs`, the compare view
  from `<A>` with every change other than the `entries/<id>.json` files and `revoked.json` read, and the owner's own list. Without
  the owner's approval on his phone such a run still reaches no secret.
- **Not testable**, so the owner's rules: that no agent shell ever gets a GitHub token with more rights than the agents' token (the
  owner's everyday token, which has `admin:org`, can approve deployments and rewrite environments) or a signed-in GitHub session; and
  that the settings were not changed and changed back between two runs of the check.
- **Owner's written confirmation** (once): "I approve `index` and `mirror` only from GitHub Mobile; Claude in Chrome is blocked on
  github.com; no agent shell holds a GitHub token other than the agents' fine-grained token, and none will."
  Confirmed on: _(date, owner)_.

## The agents' token (owner decision 2026-11-18, Q16: T1, done)

**Switched on 2026-11-18.** The agents' `gh` login is the owner's fine-grained personal access token:

- **Resource owner:** the organization `eve-cyno` only. **Organization permissions:** none.
- **Repository permissions:** reads (Metadata, Contents, Actions, Issues, Pull requests), plus **Secrets and Environments, read and
  write, for good** (owner decision 2026-11-18): the coordinator sets secrets and environment variables with the commands of
  "Secrets and variables", and the permissions are never added for a task and taken away after it.
- **Variables, read** is needed since 2026-11-19: C-ENV1 lists the repository's and the organization's variables to check that no
  `MINISIGN_*` or `R2_*` is set there, and without that read it fails closed. It also lists the environments and each one's secrets
  and variables other than `index` and `mirror`, with the reads above; a list it cannot read fails closed too.
- **Off, and checked before every approval:** **Administration** (it creates and changes environments, their reviewers, branch
  rules and admin bypass), **Deployments write** (it approves or rejects a waiting run) and **Actions write** (it dispatches runs
  and deletes runs and artifacts). No Workflows permission.
- Git pushes go **over SSH** and need no API permission.
- The everyday token (classic, with `admin:org`) stays off every agent shell.

The coordinator's first checks with it (2026-11-18, before Secrets and Environments were added): `PATCH repos/eve-cyno/plugins`
answered 403, and reads work. Those are not yet the full record below.

So the agents' token cannot approve a deployment, change an environment's protection, delete runs or artifacts, or dispatch a run;
every dispatch, test runs included, is the owner's own. It can replace secret values ("One account" says what that allows).
`tools/check-envs.mjs` checks the token with six probes; there is no mode without them:

- **Four must be refused:** exactly HTTP 403 with the message "Resource not accessible by personal access token" and an
  `x-ratelimit-remaining` above 0. Anything else fails, a 404 included.
- **Two must be allowed:** the secrets lists answer HTTP 200 with a list. They show names only, never values, and the check prints
  neither. A refusal there fails too: it means the token is not the one described here.
- **The create probe** first checks with a GET that the environment `c-env1-probe-denied` does not exist (HTTP 404), then asks to
  create it; on any other answer to the GET the check fails and sends no request to create it. It is the only probe that could change something. If it is ever allowed, the token has Administration: the check
  fails with an `ALARM` line, first in its output and on stderr, and the owner deletes that environment (Settings, Environments,
  `c-env1-probe-denied`, Delete environment) and takes Administration off the token before any approval. If the environment
  exists when the check starts, the check fails until the owner has deleted it.

| Permission | Request | Agents' token: expected | Agents' token: measured | Everyday token (measured once) |
|---|---|---|---|---|
| Administration | `GET repos/eve-cyno/plugins/keys` | 403 | not measured yet | not measured yet |
| Environments | `GET repos/eve-cyno/plugins/environments/index/secrets` | 200, a list | not measured yet | not measured yet |
| Secrets | `GET repos/eve-cyno/plugins/actions/secrets` | 200, a list | not measured yet | not measured yet |
| Deployments (approve) | `POST repos/eve-cyno/plugins/actions/runs/1/pending_deployments` (`state=rejected`, run 1 does not exist here) | 403 | not measured yet | not measured yet |
| Actions write | `DELETE repos/eve-cyno/plugins/actions/artifacts/1` (no such artifact) | 403 | not measured yet | not measured yet |
| Administration (create environment) | `PUT repos/eve-cyno/plugins/environments/c-env1-probe-denied` (after a GET that answers 404) | 403 | not measured yet | never sent: it would create the environment |

The coordinator records the agents' column after the token change, and the owner the everyday column once, with `gh api -i` and
the same request (never the `PUT`). Whether GitHub checks the permission before it looks up a run or artifact that does not exist
is not documented: if the agents' token gets a 404 on either of those, that check always fails closed and the coordinator decides.

**Empirical approve check, once after the token switch (coordinator).** The probe above names a run that does not exist; this one
uses a real run that waits for approval, and is safe because the request asks to reject and a refused request changes nothing. A push
starts no such run, the first push included: `check.yml` runs on pull requests only, `publish.yml` only when dispatched and
`resign.yml` on its schedule or when dispatched, so the waiting run comes from the owner's dispatch:

1. The owner dispatches `publish.yml` with `target: test` and lets it wait at the `mirror` approval (do not approve yet).
2. The coordinator, in an agent shell with the agents' token, reads the run id from the run page and the environment id with
   `gh api repos/eve-cyno/plugins/environments/mirror --jq .id`, then sends:

   ```
   gh api -i --method POST repos/eve-cyno/plugins/actions/runs/<run id>/pending_deployments \
     -f state=rejected -f comment='empirical approve check with the agents token' -F 'environment_ids[]=<mirror id>'
   ```

3. Expected: HTTP 403 with "Resource not accessible by personal access token"; the run still waits. The coordinator records the status
   line and message here. Any 2xx means the token can review deployments: the test run's `mirror` is then rejected (nothing uploads;
   that is why the request rejects), and no run is approved until the owner has replaced the token.
4. The owner then approves or rejects the waiting run from his phone, after the steps below as for any test run.

Result: 2026-11-19, on `target: test` run 44491400412 (commit `6925bbf`) waiting at `mirror`: `HTTP/2.0 403 Forbidden`, `Resource not accessible by personal access token`; the run kept waiting. The request was sent from the agents' token in the coordinator's shell (typed by the owner there, since the coordinator's own call was held back by its permission check). The owner then approved `mirror` from his phone (09:51Z) and the run ended `success` (`build`, `sign-test`, `upload`; `sign` skipped, as for every test run). Since then the `verify` job runs after every successful `upload`, a test run's included. A run cancelled after its upload skips `verify`: the coordinator then re-checks the live index locally with `tools/publish/verify-live.mjs` (`--target <target> --in <folder>`, from the trusted worktree) before the next run.

## Before every index and mirror approval

This comes before **every** approval of `index` or `mirror`: both workflows, both targets (a `target: test` run has a `mirror`
approval only). The owner (the environments' only reviewer) does the reading in a browser and approves only from GitHub Mobile.
`<B>` is the run's single commit (`github.sha`, shown on the run page).

1. **Settings and workflows.** The coordinator has run, for this run, the trusted worktree's tools ("Roles") in a shell in
   `<checkout>`, with the agents' token and `<B>` fetched into `<checkout>`:

   ```
   node ../eve-cyno-plugins-trusted/tools/check-envs.mjs --rev <B> --repo-dir <checkout>
   node ../eve-cyno-plugins-trusted/tools/base-tree.mjs --rev <B> --out <new empty folder> --repo <checkout>
   node ../eve-cyno-plugins-trusted/tools/check-workflows.mjs --dir <that folder>
   ```

   `check-workflows.mjs` runs the trusted worktree's rules (C-WF1 onwards, `tools/lib/wfrules.mjs`) over `<B>`'s workflows and the
   files they read, in `<B>`'s tree written byte for byte as `check.yml` writes its base. It must print `WORKFLOWS PASS` (exit 0).
   The rules follow links, so a link at or under `.github` (which `base-tree.mjs` already refuses to write) or at `tools` or `docs`,
   or anything under `.github` that is neither a file nor a folder, is a `TREE FAIL` line and no rule runs (`WORKFLOWS FAIL tree`).
   A `FAIL` line means no approval, with one exception, a judgment call kept on purpose (no tool decides it; the owner does): a
   commit that changes a rule together with the workflow it pins fails the older rules once; then every failing line must name a
   workflow part that the compare view of step 5 (step 4 for a first publish) shows changed, and the owner reads that part there.
   `TREE FAIL` has no exception.
   `check-envs.mjs` must print `C-ENV1 PASS` (exit 0). It checks both environments (one required reviewer, the same user on both,
   self-review prevention off, admin bypass off, `main` only, no other rule), that the reviewer's login and id appear in no path,
   file or commit at `<B>`, and that the six probes of "The agents' token" answer as its table expects: the four refusals exactly
   HTTP 403 with the message "Resource not accessible by personal access token" and an `x-ratelimit-remaining` above 0, the two
   secrets lists HTTP 200.
   It lists the six secrets and variables the workflows read, each in its environment with its `updated_at`: compare each date with
   the day the owner or the coordinator set that value ("One account"). It checks the two variables' values without printing them,
   that `index` and `mirror` hold nothing beyond those six (it names an extra one, never its value),
   and that no secret or variable named `MINISIGN_*` or `R2_*` is set at repository or organization level or in any environment
   other than `index` and `mirror` (it prints the other environments' names).
   Any other answer fails, and no option skips the probes. An `ALARM` line means the check created the environment
   `c-env1-probe-denied`: no approval until the owner has deleted it and taken Administration off the token. A pass is not proof
   that nothing changed between the check and the approval; that rests on the owner's rules above.
2. **Find `<A>`, the last approved base.** `<A>` is the commit of the newest run of `publish.yml` or `resign.yml`, **other than the
   run under review**, that this repository's own dispatch (`publish.yml`) or dispatch/schedule (`resign.yml`) started (head repository
   `eve-cyno/plugins`) and that has an approval of `index` by the environment's reviewer (the owner) and whose `sign` and `upload` jobs
   both concluded `success`. Not the newest green run: a no-op re-sign ends green at `check`, a scheduled run takes `main`'s head, and
   a `target: test` run has no `index` approval. The coordinator runs the trusted worktree's copy:

   ```
   node ../eve-cyno-plugins-trusted/tools/approved-base.mjs --run <run id>
   ```

   It reads the reviewer from environment `index`, and prints `<B>`, one `skip` line per newer run with the reason, `<A>` with its
   run, the compare status and the compare link. A fork can change `publish.yml` to run on `pull_request` and name its branch `main`. Its
   run then has the path and branch of a run of `main`, so any run started by another event or repository is skipped before its
   approvals and jobs are read. A run under review that fails the same rule is an `ERROR`: no approval. The fork rule protects the
   reviewer only once `<A>` contains this check's commit (before the first publish: the commit the owner read in full). `repairbase`
   stays on branch only, so a fork re-run (attempt 2 or later) blocks recovery R2 until the owner deletes that run (fail closed). Exit 0: `<A>` found, status `ahead` or `identical`; 1: `NO APPROVAL`, `NOT A FIRST
   PUBLISH` (step 4) or `ERROR` (a
   failed request, an incomplete list or an environment without exactly one reviewer is an error, never "no approved run"); 3:
   `FIRST PUBLISH` (step 4). A re-run counts by its attempt 1: every job refuses any attempt but the first, so the tool reads the
   jobs of every attempt (`jobs?filter=all`, each job names its attempt) and judges attempt 1's `sign` and `upload`. GitHub lists the
   approvals of the latest attempt only (measured on 2026-11-19, "Measurements"): a re-run's list does not show attempt 1's approval. So a
   re-run without an `index` approval (a re-run `target: test` run, say) is skipped only once its jobs show that attempt 1's `sign`
   did not succeed; `sign` is the job that asks for the `index` approval, so one that succeeded with no approval listed is an
   `ERROR`. It is an `ERROR` too when a re-run's attempt 1 cannot be read from the jobs list (a job without a valid attempt, no job of
   attempt 1, or a later attempt's `sign` or `upload` shown as succeeded), and when an approved run's attempt 1 has no `sign` job
   ("When a run is red", the `Refuse a re-run` row). The tool is a convenience: confirm on `<A>`'s run page that the `index`
   approval shown is your own.
   The `<A>` it prints must be the trusted worktree's commit (`git -C ../eve-cyno-plugins-trusted rev-parse HEAD`; with `FIRST
   PUBLISH`, that commit must be `<X>`, the newest `read in full` line of the list). When it is not, stop: either the worktree was
   not moved after the last approved run (move it once step 3 has confirmed `<A>` against the list, then start again at step 1), or
   the list does not hold that run (no approval).
   The agents' token cannot write an approval record or change who may approve, so an approval by the owner's account means the
   owner approved, on his phone.
3. **Check against your own list.** GitHub's run history can be deleted by a workflow with `actions: write`, and an agent can push
   such a workflow over SSH ("One account", the residual). So the owner keeps a list outside GitHub and outside the workstation (for
   example a note on the phone), one entry per **production `index` approval**:

   | run id | workflow | commit | head `generated` | `sign` | `upload` |
   |---|---|---|---|---|---|

   Write the first four at the `index` approval (the `generated` from the run summary, after step 5), and the outcome of `sign` and
   `upload` after the run. Test runs are not entries; refused approvals and failed runs are entries only as far as they got. The
   list also holds the lines `read in full <commit> <date>` ("Owner steps before the first production publish", step 0, and step 4
   below); they are not run entries.
   **No approval** when: `<A>` is not the newest entry of the list whose `sign` and `upload` both succeeded (the run under review
   aside); a run of the list no longer shows on GitHub; or the live base (the verified live head, or R2's base) has a `generated` older
   than that newest entry's (an older verified head was replayed).
4. **First publish only** (the tool says `FIRST PUBLISH`, there is no `<A>`): allowed only while no entry of your list has a
   successful `sign` (a signed head may have gone live, as recovery R2 counts it). After such an entry, a run that calls itself a
   first publish means **no approval**. When GitHub shows such a run but none with a successful `upload`, the tool says `NOT A FIRST
   PUBLISH`: then only a repair run (`repair: true`, step 6) may be approved, read as this step says, since there is no `<A>`
   (once that run is 90 days old, not even that: "Recovery R2", a dead end at 90 days). In place of `<A>`, the base is `<X>`, the
   newest `read in full <X> <date>` line of your list, at which the trusted worktree stands (step 2 checked it). Unless `<B>` is
   `<X>`, read `<B>` in full in the order of "Owner steps before the first production publish", step 0, with `<B>` as `<Y>`: the
   compare status of `<X>` to `<B>` `ahead` or `identical`, and every change of
   `https://github.com/eve-cyno/plugins/compare/<X>...<B>` other than the `entries/<id>.json` files, `revoked.json` and `vendor/`,
   `package-lock.json` included; then the coordinator runs the vendor check of step 0.2 there for `<B>` from the unmoved worktree
   (still at `<X>`) and hands over its output; then you read `vendor/` against that output and add `read in full <B> <date>`.
   Only then does the coordinator move the worktree to `<B>` ("Roles"), and steps 1 and 2 run again from it. For a first publish
   this reading is step 5.
5. **Check the direction, then read the change** (after `FIRST PUBLISH`, step 4 is this step). The compare status of `<A>` to
   `<B>` must be `ahead` or `identical`; `behind` or `diverged` means **no approval**. Then read
   `https://github.com/eve-cyno/plugins/compare/<A>...<B>`: **every change other than the `entries/<id>.json` files and
   `revoked.json`** (anything else in `entries/` too, such as a `.gitattributes`; workflows, tools,
   vendor, `package.json`, `package-lock.json`, any `.npmrc`, schemas, docs), because `npm ci` in `build` and `upload` runs what the
   manifest and lock file name, with the `mirror` secrets in `upload`. Read the
   entries and revocations in the summary and the pull request. Anything unexpected: no approval.
   A change under `vendor/` (generated code, not read line by line) is read as step 0 of "Owner steps before the first
   production publish" reads it, with `<B>` in place of `<Y>` and the worktree left at `<A>`: first every other change of the
   compare view, then the coordinator runs the vendor check of step 0.2 for `<B>` and hands over its output, then you read
   `vendor/` against it as step 0.3 says. A failed check, or a desktop commit you do not accept: no approval.
   When `<A>...<B>` changes `vendor/` and also `tools/vendor-host.mjs`, `tools/base-tree.mjs`, `tools/lib/basetree.mjs` or
   `tools/lib/gitsafe.mjs`: no approval, whatever the check prints (step 0.2); the tool change must first reach `<A>` through an
   approved run whose `sign` and `upload` succeeded, and the `vendor/` change comes in a later run.
6. **Repair runs only** (`repair: true`): the coordinator hands over the output of a local
   `node ../eve-cyno-plugins-trusted/vendor/eve-cyno-host/scripts/index-verify.mjs --live --archives` that shows the live index
   failing to verify. Read in the run
   summary which candidate runs gave the base and where the floor came from; check each named run on its own page and against your
   list: every entry younger than 90 days with a successful `sign` must be among the candidates, and one missing means no approval.
   The word REPAIR in the run name and summary is printed by workflow code, so trust it only after steps 2 and 5 showed that code
   unchanged or read.
7. Only then approve. The run summary is a convenience; it never replaces steps 1 to 5 (and 6 for a repair).

**At the `mirror` approval of the same run**, repeat steps 1, 2, 3, 5 and (for a repair) 6 with the same `<B>`. `<A>` excludes the run
under review, so it is the same `<A>`; read the change again with the `upload` job's code in mind (it runs with the `mirror` secrets).
After `FIRST PUBLISH`, `<B>` is by then the newest `read in full` line, so step 4 has nothing left to read; read `<B>` again with the
`upload` job in mind. For a `target: test` run, this is the first and only reading (with `FIRST PUBLISH`, step 4 included).

## Owner steps before the first production publish

Step 0 comes before everything else: before the first entry pull request is merged, before the next `target: test` run is
approved, and before any `node` command of this runbook runs (steps 2, 3 and 6 of the list included), since every such command
runs from the trusted worktree ("Roles") and there is none before it. Three more steps come first; each is repeated in the list
below. O1 is the owner's alone.

- **O1, the approver.** The environments list the owner's own account as their only reviewer ("The environments"). The owner
  installs GitHub Mobile on his phone, signs in with 2FA and turns on its push notifications; he approves only there. He sets the
  Claude in Chrome extension's site permission for `github.com` to blocked. Then he writes the confirmation in "One account" above.
- **O2, the agents' token** (done 2026-11-18). The owner made the fine-grained token of "The agents' token" (organization
  `eve-cyno` only; reads, plus Secrets and Environments read and write for good; no Administration, Deployments write or Actions
  write) the agents' `gh` login and keeps the everyday token off every agent shell; agents push over SSH. Still open: the
  coordinator runs `tools/check-envs.mjs` (four refusals 403, two secrets lists 200) and fills in the probe table (the owner gives the
  everyday column). The empirical approve check is done (2026-11-19, recorded in "The agents' token": HTTP 403).
- **O3, the secrets** (done 2026-11-18). The index key and its passphrase, the R2 keys and the two variables were set with the
  commands of "Secrets and variables": the index key from the encrypted backup on stdin, the R2 keys typed by the owner into a
  password dialog. Nobody pasted a value into a web page, a chat or a terminal.

0. **The first trusted commit `<X>`.** The coordinator names `<X>`, the head of `main` then (`git rev-parse origin/main`, 40 hex),
   and adds the trusted worktree at it without installing anything (`git -C <checkout> worktree add --detach
   ../eve-cyno-plugins-trusted <X>`). Before he reads, the owner compares the 40-hex `<X>` the coordinator printed with the head of `main` on github.com
   (`https://github.com/eve-cyno/plugins/commits/main`); for a later commit `<Y>` (read as `<B>` at an approval), with the commit its run
   page shows, not `main`'s head, which may have moved on; any difference: no line. Then the owner reads `<X>` in full, in this order. The same order reads a later commit `<Y>`
   in full ("Before every index and mirror approval", step 4), with `<Y>` in place of `<X>` and the compare view from the newest
   `read in full` commit in place of every file:
   1. The owner reads every file at `<X>` (`https://github.com/eve-cyno/plugins/tree/<X>`) other than the `entries/<id>.json`
      files, `revoked.json` and `vendor/`: tools, workflows, `package.json`, `package-lock.json`, any `.npmrc`, schemas, docs. For
      `<Y>`: the compare status of the newest `read in full` commit to `<Y>` is `ahead` or `identical`, and he reads every such
      change of `https://github.com/eve-cyno/plugins/compare/<that commit>...<Y>`.
   2. **The vendor check.** The worktree does not move: for `<Y>` it stays at the commit whose code the owner read last (the
      newest `read in full` commit, or `<A>`), and the commit under review is only read, as a tree written into a new empty folder
      `<T>` outside every repository. The coordinator reads the desktop commit `<D>` that `<T>/vendor/eve-cyno-host/MANIFEST.json`
      names (`desktop.commit`, 40 hex; read as data, nothing of `<T>` runs), and runs in `<checkout>`:

      ```
      (cd ../eve-cyno-plugins-trusted && npm ci --ignore-scripts)    # for <X> only, once
      node ../eve-cyno-plugins-trusted/tools/base-tree.mjs --rev <X or Y> --out <T> --repo <checkout>
      git -C <desktop checkout> fetch origin main
      node ../eve-cyno-plugins-trusted/tools/vendor-host.mjs --check --from <desktop checkout> --rev <D> --root <T>
      ```

      and hands over the output of the last command. It first confirms that `<D>` is on desktop `main` (an ancestor of
      `refs/remotes/origin/main` of the desktop checkout, or that commit), and otherwise stops with `FAIL desktop <D> is not on
      desktop main` before it exports or builds anything: the make runs the desktop's own `npm ci` and build scripts at `<D>`,
      which only desktop `main` vouches for. Then it compares `<T>`'s `vendor/eve-cyno-host` with a fresh make, file by file.
      `base-tree.mjs` and this check load no vendored module; no other tool runs from the worktree until the owner has read
      `vendor/`. For `<Y>`, a change to `tools/vendor-host.mjs`, `tools/base-tree.mjs`, `tools/lib/basetree.mjs` or `tools/lib/gitsafe.mjs`
      lands in a commit range with no `vendor/` change: the owner reads it in full and the worktree moves to it; only then does a
      `vendor/` change follow, checked by the moved worktree's tools. A range that holds both means no `read in full` line.
   3. The owner reads `vendor/` against that output: the check passes (`<D>` is on desktop `main`, and no difference from a fresh
      make), and `<D>` is a desktop commit he accepts. Any doubt, or a failed check: no line (for `<X>`, the coordinator removes
      the worktree).
   4. He adds `read in full <X> <date>` to his list (outside GitHub and the workstation, "Before every index and mirror approval"
      step 3). Until the first production run whose `sign` and `upload` succeeded, the newest such line names the trusted
      worktree's commit. For `<Y>`, the coordinator moves the worktree to `<Y>` only after that line is written ("Roles").
1. The environments exist with the settings above; the written confirmation in "One account" is filled in.
2. The token is switched (O2, done): `node ../eve-cyno-plugins-trusted/tools/check-envs.mjs --rev <main's head> --repo-dir
   <checkout>` passes, the probe table is filled in, and the empirical approve check is recorded with a refusal.
3. Nothing in the repository names the owner's login or user id: that `check-envs.mjs` run passes at `main`'s head.
4. The secrets and variables are set (O3, done; "Secrets and variables" has the commands to set them again).
5. **Pinned actions** (done 2026-11-18). Every `uses:` names the full 40-hex commit of a release tag, with the tag as a trailing
   comment, and the static rule C-WF2 fails on anything else (a tag, a short SHA, a placeholder, a missing tag comment, or one action
   pinned two ways). The pins, read anonymously from the public repositories (`git ls-remote https://github.com/actions/<name>
   'refs/tags/v*'`, a shallow fetch of the tag to confirm it names a commit, and the release list for the date and the prerelease
   flag), each the newest stable release that was at least two weeks old:

   | Action | Tag | Commit | Released |
   |---|---|---|---|
   | `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | 2026-07-20 |
   | `actions/setup-node` | `v7.1.0` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | 2026-10-08 |
   | `actions/upload-artifact` | `v7.0.2` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | 2026-10-07 |
   | `actions/download-artifact` | `v8.0.2` | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | 2026-10-07 |

   A new pin is read the same way and changes every `uses:` line of that action in one commit; the owner reads it in the compare
   view like any other workflow change.
6. **Vendor.** The vendored host is re-made from the current desktop `main` that holds the index scripts' new options, and
   `EVECYNO_VENDOR_STRICT=1 npm test` and `node tools/vendor-host.mjs --check --from <desktop checkout> --rev <that commit>` pass
   in the checkout that holds the change (the coordinator's gate on its own change, not a reading; the check fails on a desktop
   commit that is not on desktop `main`). The owner reads the new `vendor/` against the vendor check of step 0.2, run from the
   unmoved trusted worktree, in the order of step 0 (or of step 4 or 5 of "Before every index and mirror approval").
7. **Free tier.** The R2 free-tier table (storage, Class A, Class B headroom) in the infra repository's hosting runbook holds the
   owner's dashboard reading of 2026-11-19 (confirmed; billable usage $0.00 then). Storage beyond the free
   10 GB-month is accepted (owner, 2026-11-18); another paid product, Infrequent Access, a cache purge token or a monthly R2 bill
   above 1 USD goes to the owner first. The owner looks at the bucket's R2 metrics once a month.
8. **Q10, no empty head.** The first production head goes out with the first approved entry, never empty: any verified head shows the
   Marketplace to every product build.
9. **The schedule** of `resign.yml` on this public repository is approved (owner, 2026-11-18). If it is ever withdrawn, `resign.yml`
   keeps only `workflow_dispatch`, and the uptime alarm plus a monthly item of this runbook replace the schedule.

## First test publish (Phase 2 proof)

After step 0 of the owner steps (the trusted worktree), the owner dispatches `publish.yml` with `target: test`. `build` uses the prefix `https://plugins.eve-cyno.dev/test/v1/`, `sign-test`
(no environment) signs with a throwaway key made in the run, and `upload` writes under `test/v1/` after the owner's `mirror`
approval (steps above). The app never reads `test/v1/`. Record from this run, in "Measurements" below: whether a run waiting for
approval holds the `index-sign` group, and how long a pending approval stays open.

## Publishing

1. Merge the entry pull requests locally on `main` and push them, one pull request at a time, only after the owner has said "merge"
   for that pull request's head commit ("Roles"), and merge only the commits the checks ran on. `<checkout>` is the coordinator's
   checkout where the merge happens, and the shell's folder; every `node` command runs the trusted worktree's copy
   (`node ../eve-cyno-plugins-trusted/tools/...`, "Roles"), never `<checkout>`'s. For pull request `<n>`:
   1. Read its head commit `<H>`: `gh pr view <n> --repo eve-cyno/plugins --json headRefOid --jq .headRefOid`.
   2. Find the newest `check.yml` run of `<H>`: `gh run list --repo eve-cyno/plugins --workflow check.yml --commit <H> --json
      databaseId,headSha,conclusion,createdAt`. Read the jobs, not the run's conclusion: `gh run view <id> --repo eve-cyno/plugins --json jobs --jq '.jobs[]|[.name,.conclusion]'`. The `checks` job
      must be `success`, and the `review` job `success` or reviewed by the owner. The run's own conclusion is red whenever `review` exits 3
      (a review class was named), so it cannot be the gate.
      Both jobs print `base <B>, head <M>` (`gh run view <id> --repo eve-cyno/plugins --log | grep -m2 'base '`): `<B>` is the
      `main` they checked against, `<M>` GitHub's merge commit of `<B>` and `<H>`. Both jobs run the pull request's own
      `tools/check.mjs` and workflow file, so their green means something only when step 4a says `SCOPE ENTRIES-ONLY`.
   3. Fetch the head: `git fetch origin pull/<n>/head`; `git rev-parse FETCH_HEAD` must be `<H>` (no commit was pushed after the run).
   4. `git rev-parse main` and `git rev-parse origin/main` must both be `<B>`. When `main` moved on (an earlier merge was pushed),
      the run checked another base: do not merge; close and reopen the pull request so `check.yml` runs on the current `main`, and
      start again at step 2.

      **4a, the scope, before the merge.** `node ../eve-cyno-plugins-trusted/tools/merge-scope.mjs --repo-dir <checkout> --base <B>
      --head <H> --merge-base` (what `<B>...<H>` shows; it reads git plumbing only and runs no code of the pull request). Its first
      line names the merge base `<MB>`. The coordinator hands the owner the output and the link
      `https://github.com/eve-cyno/plugins/compare/<MB>...<H>`, both as full commit ids: it shows the pull request's change at
      `<H>` and nowhere else. The owner reads there, never in "Files changed", which shows whatever head the pull request has by
      the time he looks (a force-push after step 3 changes that, not `<H>`).
      - `SCOPE ENTRIES-ONLY` (exit 0): the pull request changes only regular files `entries/<id>.json` and `revoked.json`, so the
        jobs ran `<B>`'s own tools and workflow and their results stand. The owner reads the entries and revocations at the link
        and the jobs' summaries (review classes included).
      - `SCOPE OWNER <names>` (exit 3): the jobs' green proves nothing. The owner reads every change at the link: the entries and
        revocations as above, and every other change (the lines marked `owner`: a tool, a workflow, `package.json` or
        `package-lock.json`, `entries/.gitattributes`, a deletion, a link or a mode change), each ticked off as below.
      - An `ERROR` or any other exit: no merge, and nothing to read. The pull request is rebased or fixed (two merge bases: rebase
        it on `main`), then start again at step 1.

      **What counts as read.** When step 5a says a path was in the compare view, it means git's answer (the path changed from
      `<MB>` to `<H>`), not that GitHub showed it. GitHub can show less than the change: it cuts the file list of a large
      compare, hides a diff behind "Load diff", collapses a file that a `.gitattributes` marks `linguist-generated`, and prints
      "Binary file not shown" for a binary file. None of those is a reading. So the owner ticks off each `owner` line of the
      output in the compare view: he finds that path in the list, opens its diff (every "Load diff" and every collapsed file),
      and reads all of it. A text file whose diff GitHub does not show he reads in full at
      `https://github.com/eve-cyno/plugins/blob/<H>/<path>`, with `<H>` as all 40 hex digits. A binary file, a path missing
      from the list, or an output that cuts its own list (`... more changes`) cannot be ticked off: no "merge"; the pull
      request is changed or split, then start again at step 1.

      Then he says "merge" with the full commit id of `<H>`, all 40 hex digits ("merge
      0123456789abcdef0123456789abcdef01234567"), or not. A "merge" without them, with fewer digits, or with other digits (he
      read another head) is no "merge" for this `<H>`: start again at step 1. A prefix is not enough: whoever makes both commits
      can make two with the same first 12 digits (48 bits, about 2^24 hashes), show the owner one and have the other merged. A
      "merge" counts only for the handoff it answers: every start again at step 1, for whatever reason and even with the same
      `<H>`, needs a new handoff of this step and a new "merge"; the coordinator never reuses an earlier one. No merge without
      his "merge", an entries-only pull request included; nothing here merges on a tool's answer.
   5. Merge `<H>` with a merge commit (`git merge --no-ff <H>`), then confirm `git rev-parse HEAD^1` is `<B>` and
      `git rev-parse HEAD^2` is `<H>`. Then `git fetch origin pull/<n>/merge`: `git rev-parse FETCH_HEAD` must still be `<M>`, and
      `git rev-parse HEAD^{tree}` must equal `git rev-parse FETCH_HEAD^{tree}`: the merged files are the files the jobs checked.
      This check is never skipped. When GitHub serves another merge commit (`<M>` moved: a push to the pull request or to `main`),
      or the trees differ: `git reset --hard <B>`, do not push, and start again at step 1 (with a new "merge", step 4a).

      **5a, the scope of the merge, before the push.** `node ../eve-cyno-plugins-trusted/tools/merge-scope.mjs --repo-dir
      <checkout> --base <B> --head HEAD --read <H>` (what the merge commit changes on `<B>`, its first parent). With `--read`, the
      tool first reads `HEAD`'s commit object: its parents must be exactly `<B>` and `<H>`, in that order (a fast-forward, a
      squash, an octopus or swapped parents is an `ERROR`). Then every
      path it marks `owner` must be the object `<H>` names there, and a path that `<H>` changed from `<MB>`, so the link of step 4a
      showed it; the tool compares git objects, not the printed names. It must print `SCOPE ENTRIES-ONLY` (exit 0), or, when step
      4a printed `SCOPE OWNER`, a `read <H>` line and `SCOPE OWNER` (exit 3). Anything else (`SCOPE OWNER` after an entries-only
      step 4a, `SCOPE UNREAD`, exit 4, for a path the owner did not read at `<H>`, an `ERROR`): `git reset --hard <B>`, do not push,
      and start again at step 1.
   6. Push `main` (`git push origin main`). The next pull request's run checked the old `main`, so step 4 sends it round again.
2. Before the dispatch, `git rev-parse origin/main` must be the merge commit of the last step 1.5. The owner dispatches
   `publish.yml` with `target: production` (`lift` empty unless a revocation is being lifted; `repair` false), and
   `gh run list --repo eve-cyno/plugins --workflow publish.yml --limit 1 --json headSha` must name that commit.
3. `build` checks against the live base and prints the head's bytes and SHA-256 in the summary. Approve `index` only after the steps
   above; then `mirror`, after them again.
4. After the run, add the outcome of `sign` and `upload` to your list.

Every run has one commit (`github.sha`); `build` fails if that commit is no longer the head of `main`. **No run is ever re-run**, not
even its failed jobs: the first step of every job fails on any attempt but the first. Dispatch a new run.

## Re-sign

- `resign.yml` runs every Monday at 06:17 UTC and can be dispatched. The schedule is an exception to the EVE-Cyno rule that workflows
  are manual-only, for `eve-cyno/plugins` only, approved by the owner on 2026-11-18. Its `check` job reads the live head and ends the run (green, no
  approval asked) unless the head is 30 days old or more, or fewer than 30 days remain before it expires. Otherwise `head` makes a new
  head with the same catalog and a new `generated` (60 days), and `sign` and `upload` need the owner's approvals of `index` and
  `mirror`, each after the steps above.
- Until the first production publish the scheduled Monday run is red: there is no live head, and `check` refuses a missing head (HTTP 404)
  because a re-sign never makes a first publish or repairs. That is expected before the first publish. The code stays as it is: after a
  publish, a missing head must stay red. The first publish ends it.
- `resign.yml` never repairs: when the live head does not verify, `head` fails with a pointer to recovery R2.
- `resign.yml` never re-signs a catalog that is not `main`'s: `check` (every week, even when no re-sign is due), `head` and `upload`
  refuse with `MAIN DIVERGES` when the live catalog differs from the one `main` builds (a revocation on one side only, a listing, a
  version or an archive). A re-sign gives the head a new `generated`, so an older verified head replayed into the mirror would come
  back fresh and apps would drop the revocations it lacks. If `main` was not published yet, dispatch `publish.yml`; if it was, the
  live head is a replay: treat it as a security event before anything else.
- GitHub disables scheduled workflows in a public repository after 60 days without repository activity, and a re-sign makes no
  commit. The uptime alarm posts to Discord `#deploy-log` when fewer than 21 days remain. Then the owner re-enables the workflow
  (Actions tab, `resign`, "Enable workflow") and dispatches it.

## Revocation

1. A report arrives (Discord, in-game, or a finding of ours).
2. The owner, or a maintainer acting for him, opens a pull request `revoke <id> <versions>` with the entry in `revoked.json`; check C15
   reads it.
3. The owner says "merge" with the 40-hex `<H>` of the pull request, as for every index pull request ("Roles"), and the coordinator merges
   it locally at once, as in "Publishing" step 1 (the merged commits are the ones `check.yml` ran on). The owner dispatches
   `publish.yml` (`target: production`); the owner approves `index` and then
   `mirror`, each after the steps above. The summary's "revocations added" line is a convenience.
4. Apps apply it at their next check (at most 4 hours) or next start; a revoked plugin is disabled at once with a notice and keeps its
   data. The archive stays in the mirror.

**Lifting.** A revocation leaves only through a pull request that deletes it (C15 flags `lift`) and a `publish.yml` run whose `lift`
input names it exactly, one `<id> <versions>` per line; `build` fails otherwise.

## When a run is red

| Where | What it means | What to do |
|---|---|---|
| `Refuse a re-run` step | someone re-ran the run | nothing was built, signed or uploaded by this attempt; dispatch a new run. The re-run itself needs no recovery: `approved-base.mjs` and the repair base read the jobs of every attempt and judge attempt 1, and skip the run when it has no `index` approval and its attempt 1 did not sign. Only when they stop with an ERROR at that run (attempt 1 not readable from its jobs list, a later attempt's `sign` or `upload` shown as succeeded, or attempt 1 signed with no `index` approval listed) does the owner read each of its attempts on the run page against his list, and find `<A>` (or, for a repair, the candidates) by hand while that run is newer than `<A>` |
| `build` or `head` | a check failed, or the commit is no longer `main`'s head | read the summary; fix through a pull request; dispatch a new run |
| `sign` | the key, passphrase, head checks or signature verification failed | nothing left the job but the error; set the `index` secrets again with the command of "Secrets and variables" and check the head; dispatch a new run |
| `build` or `upload`, `LIVE UNVERIFIED: catalog/<sha256>.json: HTTP 404` or `not the one the live head names` | the head and signature verify, but the catalog they name is gone or another file (the pair verifies, the catalog does not; also a head over its size cap) | recovery R2: the coordinator confirms with `index-verify.mjs --live --archives`, then the owner dispatches `publish.yml` with `repair: true` |
| `build` or `upload`, `NOT BROKEN` | head, signature and catalog verify, so there is nothing to repair | dispatch without `repair` |
| `build`, `upload` or `resign`, "cannot be read" | a read of the live index or the mirror failed for another reason than a 404 or a size cap (a 429, a 503, a time-out) | nothing was written; dispatch again later |
| `upload`, "the index served is not the pair in R2" | the edge serves another index than the bucket holds | edge lag lasts seconds: dispatch again. When it persists past about 10 minutes it is a security event: see REPLAYED below |
| `upload` (resign), "the live catalog is not in R2, only in the edge cache" | a re-sign writes the head and signature only, and the catalog it names is not in the bucket | look into the deletion first; then dispatch `publish.yml` |
| `upload`, `swapped in R2` | an archive or catalog in the mirror has other bytes than the catalog names | a security event before any repair: the owner finds the writer (R2 audit) before anything else and deletes the object; a normal run then re-uploads it create-only |
| `upload`, a 412 | someone changed the live index during the run | stop; find out who wrote it (R2 audit, other runs) before anything else; then dispatch a new run |
| `upload`, other | see the R1 outcome in the job log and summary | below |
| `verify` | the live index does not read back as published | **never re-run**: the coordinator re-checks it locally with `node ../eve-cyno-plugins-trusted/vendor/eve-cyno-host/scripts/index-verify.mjs --live --archives`; a confirmed failure goes to recovery R2 |

**Recovery R1** (inside `upload`). After a failed or unanswered PUT the job reads the live objects again and ends with a final re-read
and a verification of the pair. Its outcomes:

- **published:** the new pair verifies. The `upload` job succeeds, and the `verify` job then reads the live index back as the app reads it
  (`tools/publish/verify-live.mjs`: signature, head, catalog and every archive, with the cache headers). A red `verify` is never re-run.
- **unchanged** (red): the old pair verifies, or, on a true first publish, both objects are still absent. Nothing was published;
  dispatch a new run. After a first publish this run's `sign` succeeded, so the next run is no first publish: dispatch a repair run
  (recovery R2).
- **FIRST-PUBLISH ORPHAN** (red): a new signature with no head yet. Apps read the missing head as unavailable. This run's `sign`
  succeeded, so the next run is no first publish: a repair run (recovery R2) overwrites the orphan.
- **TEST NOT PUBLISHED** (red, `target: test` only): the new test pair is not live. Dispatch a new test run.
- **REPLAYED** (red): a pair that verifies but is neither new nor old is live: someone else's verified head, possibly an older one.
  Treat it as a security event: no approval of anything until the owner has found out who wrote it; then recovery R2. A swapped catalog
  (in R2, or served by the edge) is a security event in the same way, before any repair.
- **HALF-PUBLISHED** (red), or a failed restore: the live pair does not verify. Recovery R2, or the owner's manual path (5.4).

## Recovery R2: repair

When the live index does not verify (its head, signature or the catalog the head names; one definition, `liveVerifies`, in both `build` and
`upload`), and the coordinator has confirmed it locally, the owner dispatches `publish.yml` with
`target: production` and `repair: true`. Its base comes only from verified heads: the `head`, `signature` and `catalog` artifacts of
`<A>` and of every later run whose `sign` succeeded after an approved `index` (in attempt 1: a re-run's later attempts never sign).
Any such run younger than 90 days that lacks one of
those artifacts (or has it expired) **stops the repair**, so a deleted artifact never drops a revocation silently. The unsigned live
head only raises the floor of `generated`. The approvals follow the steps above, step 6 included. If the repair stops, or no candidate
verifies, the owner follows the emergency path.

**A dead end at 90 days.** `tools/approved-base.mjs` has no age limit, but the repair takes only runs younger than 90 days as
candidates (their artifacts' retention). So when the only runs with an approved `index` and a successful `sign` never had a
successful `upload` (a first publish that signed but did not go live: `unchanged` or `FIRST-PUBLISH ORPHAN` in recovery R1), and the
newest of them is 90 days old or more, the tool says `NOT A FIRST PUBLISH` (only a repair may follow) while a repair run stops with
`NO VERIFIED BASE` (no candidate). Neither a first publish nor a repair can then be approved: the owner follows the emergency path.
To stay out of it, dispatch the repair run while that run is younger than 90 days.

## Emergency path (plan 5.4)

If `eve-cyno/plugins` or its Actions are unusable, the coordinator sets the two index secrets of `eve-cyno/desktop` again from the
backup, and nothing else: `scripts/desktop-signing-rotate.sh secrets index index --repo eve-cyno/desktop` in the infra repository.
It proves the index primary against its `.pub` and the key the app pins, decrypts into tmpfs and pipes `MINISIGN_INDEX_KEY` and
`MINISIGN_INDEX_PASSWORD` to `gh secret set` on stdin; the owner runs no decrypt command. (`scripts/desktop-signing-secrets.sh` is not
used here: it sets the two release secrets too.) Then the desktop repository's `docs/release-checklist.md`, "The plugin index", is
followed by hand: the coordinator builds with the vendored tools; the owner runs `scripts/release-sign.sh` with purpose `index`,
which only dispatches the desktop `sign.yml` (it decrypts nothing and reads no secret) and verifies the signature it downloads; the
owner uploads with his own Cloudflare login. `sign.yml` has no `environment:` and asks for no approval: its first step lets only a
login listed in the desktop repository's Actions variable `RELEASE_SIGNERS` sign, and only on `main`. So on this path that list,
not a phone approval, decides who can sign an index head.

## Rotation (plan 4.4)

As in the desktop repository's `docs/release-checklist.md`, "Key compromise and rotation": the app pins a primary and a standby
index key, and a rotation is an app release that pins the new pair. In addition, for this repository: after
`rotate.sh promote index ...` the new primary goes into the `index` environment of `eve-cyno/plugins` with the command of
"Secrets and variables" (`--repo eve-cyno/plugins`), and the vendor pin moves to the desktop commit on desktop `main` with the new
`.pub` files (`node tools/vendor-host.mjs --check` passes in the checkout of that change, a gate on it; the owner reads the change
at the next approval, step 5 of "Before every index and mirror approval", step 4 for a first publish, with `vendor/` read against
the vendor check of "Owner steps before the first production publish", step 0.2, from the unmoved trusted worktree). Both index
keys lost is not fatal (checklist, "Keys lost, not leaked").

## Known residuals

Found in review, accepted, and named here so nobody counts on more than the tools give:

- A revocation lift with `"versions": "*"` publishes a version that was added later with only a `FLAG lift` in publish mode; the pull
  request review flagged it when the version was added.
- SemVer case: `1.0.0-RC.1` and `1.0.0-rc.1` are two versions of one id and may collide on a case-insensitive filesystem (the
  installer's folder keys). Carried to the desktop.
- Any edit of the `sign` job, an action pin bump included, needs its new pin in `SIGN_STEPS` in `tools/lib/wfrules.mjs` in the same
  commit; the error prints the new hash.
- C-WF1 and C-WF11 treat ` #` inside a `run:` block as a comment; C-ENV1 backstops this.

## Measurements

Recorded once, on real runs; until then they are open.

| What | How | Result |
|---|---|---|
| Does a run waiting for approval hold the `index-sign` group? | a `target: test` run waiting at `mirror`, then a second dispatch | not measured yet |
| How long does a pending approval stay open? | the same run, within the 35-day run cap | at least 57 minutes: run 44491400412 waited at `mirror` from 08:54Z (`sign-test` done) to the owner's approval at 09:51Z on 2026-11-19, still open; the upper bound is not measured |
| Probe answers of both tokens | `tools/check-envs.mjs` after the token swap | see "The agents' token" |
| Does `GET .../actions/runs/<id>/approvals` list the approvals of every attempt of a re-run, or of the latest attempt only? | on the first `target: test` dispatch: after its `mirror` approval and its end, the owner re-runs it once, the only exception to "No run is ever re-run" (every job fails at its first step, so nothing is built, signed or uploaded), and the coordinator reads its approvals list and its `jobs?filter=all` | the latest attempt only (2026-11-19): run 44491400412 had `mirror` approved by the owner in attempt 1; after the owner's one re-run, `GET .../approvals` returned an empty list, `jobs?filter=all` showed attempt 2's `build` failed at its first step (`Refuse a re-run`) and every other attempt-2 job skipped, and no approval was requested. The tools' assumption holds |
