# Runbook: publishing the plugin index

How the index at `plugins.eve-cyno.dev` is published, re-signed, revoked and repaired, and what must be true before anyone approves a
run. The workflows are `.github/workflows/publish.yml`, `resign.yml` and `check.yml`; `tools/test/workflows.test.mjs` holds their
rules (C-WF1 to C-WF11).

Roles:

- **The owner** (his own GitHub account) merges, dispatches runs, and is the **only required reviewer** of the environments `index`
  and `mirror`. He approves only from GitHub Mobile, after the steps in "Before every index and mirror approval".
- **The coordinator** (an agent) runs `tools/check-envs.mjs`, `tools/approved-base.mjs` and local verifications, and hands their output
  to the owner. It sets secrets only with the commands of "Secrets and variables", which move each value on stdin and print none. It
  never approves a deployment, never dispatches `publish.yml` with `target: production`, and never reads a secret's value.
- **Agents** work with the agents' token (below). It cannot approve a deployment, dispatch a run, change an environment's protection
  rules, or delete runs or artifacts. It can write secrets and environment variables (owner decision 2026-11-18; "One account" names
  what that allows). Agents push over SSH.

**Hard rule.** No private key, passphrase or token is ever put in an argument list, an output, a file an agent writes, a log or a
message. The commands of "Secrets and variables" move each value on stdin only. This is a rule of conduct, not a barrier: "One
account" names what any process of the agents' user can still do with the keys.

**The owner never runs a decrypt command.** Every command below that decrypts a backup is run by the coordinator; the owner only
types a value into a password dialog that a command opens.

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
  the value), and fails on any secret or variable named `MINISIGN_*` or `R2_*` at repository or organization level: one there
  reaches every job of the repository without an approval of `index` or `mirror`.
- **The key-custody residual, named exactly.** Any process of the agents' user can decrypt `signing/desktop/keys.enc.yaml` (the
  release keys included) with the age identity under `~/.config/sops/age` and sign a head offline; the phone approval guards only
  the CI copy of the key; publishing such a head would still need R2 write; the key-custody fix (a passphrase-protected age identity
  for `signing/desktop` only) is the owner's decision. So the hard rule above is a rule of conduct for the agents, not a barrier.
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
  `MINISIGN_*` or `R2_*` is set there, and without that read it fails closed.
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

Result: _(date, status line and message)_.

## Before every index and mirror approval

This comes before **every** approval of `index` or `mirror`: both workflows, both targets (a `target: test` run has a `mirror`
approval only). The owner (the environments' only reviewer) does the reading in a browser and approves only from GitHub Mobile.
`<B>` is the run's single commit (`github.sha`, shown on the run page).

1. **Settings.** The coordinator has run, for this run, with the agents' token and `<B>` fetched into its checkout:

   ```
   node tools/check-envs.mjs --rev <B> --repo-dir <checkout>
   ```

   and it printed `C-ENV1 PASS` (exit 0). It checks both environments (one required reviewer, the same user on both, self-review
   prevention off, admin bypass off, `main` only, no other rule), that the reviewer's login and id appear in no path, file or commit at
   `<B>`, and that the six probes of "The agents' token" answer as its table expects: the four refusals exactly HTTP 403 with the
   message "Resource not accessible by personal access token" and an `x-ratelimit-remaining` above 0, the two secrets lists HTTP 200.
   It lists the six secrets and variables the workflows read, each in its environment with its `updated_at`: compare each date with
   the day the owner or the coordinator set that value ("One account"). It checks the two variables' values without printing them,
   and that no secret or variable named `MINISIGN_*` or `R2_*` is set at repository or organization level.
   Any other answer fails, and no option skips the probes. An `ALARM` line means the check created the environment
   `c-env1-probe-denied`: no approval until the owner has deleted it and taken Administration off the token. A pass is not proof
   that nothing changed between the check and the approval; that rests on the owner's rules above.
2. **Find `<A>`, the last approved base.** `<A>` is the commit of the newest run of `publish.yml` or `resign.yml`, **other than the
   run under review**, that has an approval of `index` by the environment's reviewer (the owner) and whose `sign` and `upload` jobs
   both concluded `success`. Not the newest green run: a no-op re-sign ends green at `check`, a scheduled run takes `main`'s head, and
   a `target: test` run has no `index` approval. The coordinator runs:

   ```
   node tools/approved-base.mjs --run <run id>
   ```

   It reads the reviewer from environment `index`, and prints `<B>`, one `skip` line per newer run with the reason, `<A>` with its
   run, the compare status and the compare link. Exit 0: `<A>` found, status `ahead` or `identical`; 1: `NO APPROVAL`, `NOT A FIRST
   PUBLISH` (step 4) or `ERROR` (a
   failed request, an incomplete list or an environment without exactly one reviewer is an error, never "no approved run"; so is a
   newer run on a later attempt than its first, a re-run: GitHub lists the jobs of a run's latest attempt only, and a re-run's
   attempt fails at its first step, so an earlier attempt that signed and uploaded would look skipped); 3:
   `FIRST PUBLISH` (step 4). The tool is a convenience: confirm on `<A>`'s run page that the `index` approval shown is your own.
   The agents' token cannot write an approval record or change who may approve, so an approval by the owner's account means the
   owner approved, on his phone.
3. **Check against your own list.** GitHub's run history can be deleted by a workflow with `actions: write`, and an agent can push
   such a workflow over SSH ("One account", the residual). So the owner keeps a list outside GitHub and outside the workstation (for
   example a note on the phone), one entry per **production `index` approval**:

   | run id | workflow | commit | head `generated` | `sign` | `upload` |
   |---|---|---|---|---|---|

   Write the first four at the `index` approval (the `generated` from the run summary, after step 5), and the outcome of `sign` and
   `upload` after the run. Test runs are not entries; refused approvals and failed runs are entries only as far as they got.
   **No approval** when: `<A>` is not the newest entry of the list whose `sign` and `upload` both succeeded (the run under review
   aside); a run of the list no longer shows on GitHub; or the live base (the verified live head, or R2's base) has a `generated` older
   than that newest entry's (an older verified head was replayed).
4. **First publish only** (the tool says `FIRST PUBLISH`, there is no `<A>`): allowed only while no entry of your list has a
   successful `sign` (a signed head may have gone live, as recovery R2 counts it). After such an entry, a run that calls itself a
   first publish means **no approval**. When GitHub shows such a run but none with a successful `upload`, the tool says `NOT A FIRST
   PUBLISH`: then only a repair run (`repair: true`, step 6) may be approved, read as this step says, since there is no `<A>`. Read every file other
   than the `entries/<id>.json` files and `revoked.json` at `<B>` (or the compare view from the repository's root commit to `<B>`),
   `package-lock.json` included, and `vendor/` against the coordinator's `node tools/vendor-host.mjs --check --from <desktop
   checkout> --rev <pinned commit>` output.
5. **Check the direction, then read the change.** The compare status of `<A>` to `<B>` must be `ahead` or `identical`; `behind` or
   `diverged` means **no approval**. Then read `https://github.com/eve-cyno/plugins/compare/<A>...<B>`: **every change other than
   the `entries/<id>.json` files and `revoked.json`** (anything else in `entries/` too, such as a `.gitattributes`; workflows, tools,
   vendor, `package.json`, `package-lock.json`, any `.npmrc`, schemas, docs), because `npm ci` in `build` and `upload` runs what the
   manifest and lock file name, with the `mirror` secrets in `upload`. Read the
   entries and revocations in the summary and the pull request. Anything unexpected: no approval.
6. **Repair runs only** (`repair: true`): the coordinator hands over the output of a local
   `node vendor/eve-cyno-host/scripts/index-verify.mjs --live --archives` that shows the live index failing to verify. Read in the run
   summary which candidate runs gave the base and where the floor came from; check each named run on its own page and against your
   list: every entry younger than 90 days with a successful `sign` must be among the candidates, and one missing means no approval.
   The word REPAIR in the run name and summary is printed by workflow code, so trust it only after steps 2 and 5 showed that code
   unchanged or read.
7. Only then approve. The run summary is a convenience; it never replaces steps 1 to 5 (and 6 for a repair).

**At the `mirror` approval of the same run**, repeat steps 1, 2, 3, 5 and (for a repair) 6 with the same `<B>`. `<A>` excludes the run
under review, so it is the same `<A>`; read the change again with the `upload` job's code in mind (it runs with the `mirror` secrets).
For a `target: test` run, this is the first and only reading.

## Owner steps before the first production publish

Three steps come first; each is repeated in the list below. O1 is the owner's alone.

- **O1, the approver.** The environments list the owner's own account as their only reviewer ("The environments"). The owner
  installs GitHub Mobile on his phone, signs in with 2FA and turns on its push notifications; he approves only there. He sets the
  Claude in Chrome extension's site permission for `github.com` to blocked. Then he writes the confirmation in "One account" above.
- **O2, the agents' token** (done 2026-11-18). The owner made the fine-grained token of "The agents' token" (organization
  `eve-cyno` only; reads, plus Secrets and Environments read and write for good; no Administration, Deployments write or Actions
  write) the agents' `gh` login and keeps the everyday token off every agent shell; agents push over SSH. Still open: the
  coordinator runs `tools/check-envs.mjs` (four refusals 403, two secrets lists 200), fills in the probe table (the owner gives the
  everyday column), and does the empirical approve check.
- **O3, the secrets** (done 2026-11-18). The index key and its passphrase, the R2 keys and the two variables were set with the
  commands of "Secrets and variables": the index key from the encrypted backup on stdin, the R2 keys typed by the owner into a
  password dialog. Nobody pasted a value into a web page, a chat or a terminal.

1. The environments exist with the settings above; the written confirmation in "One account" is filled in.
2. The token is switched (O2, done): `tools/check-envs.mjs` passes, the probe table is filled in, and the empirical approve check
   is recorded with a refusal.
3. Nothing in the repository names the owner's login or user id: `tools/check-envs.mjs` passes at `main`'s head.
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
   `EVECYNO_VENDOR_STRICT=1 npm test` and `node tools/vendor-host.mjs --check --from <desktop checkout> --rev <that commit>` pass.
7. **Free tier.** The R2 free-tier table (storage, Class A, Class B headroom) in the infra repository's hosting runbook is filled in
   from the Cloudflare dashboard. The first production publish waits for it. Anything that would leave the free tier goes to the
   owner first; the owner looks at the bucket's R2 metrics once a month.
8. **Q10, no empty head.** The first production head goes out with the first approved entry, never empty: any verified head shows the
   Marketplace to every product build.
9. **The schedule** of `resign.yml` on this public repository is approved (owner, 2026-11-18). If it is ever withdrawn, `resign.yml`
   keeps only `workflow_dispatch`, and the uptime alarm plus a monthly item of this runbook replace the schedule.

## First test publish (Phase 2 proof)

The owner dispatches `publish.yml` with `target: test`. `build` uses the prefix `https://plugins.eve-cyno.dev/test/v1/`, `sign-test`
(no environment) signs with a throwaway key made in the run, and `upload` writes under `test/v1/` after the owner's `mirror`
approval (steps above). The app never reads `test/v1/`. Record from this run, in "Measurements" below: whether a run waiting for
approval holds the `index-sign` group, and how long a pending approval stays open.

## Publishing

1. Merge the entry pull requests locally on `main` and push them, one pull request at a time, and merge only the commits the checks
   ran on. For pull request `<n>`:
   1. Read its head commit `<H>`: `gh pr view <n> --repo eve-cyno/plugins --json headRefOid --jq .headRefOid`.
   2. Find the newest `check.yml` run of `<H>`: `gh run list --repo eve-cyno/plugins --workflow check.yml --commit <H> --json
      databaseId,headSha,conclusion,createdAt`. Its `checks` job must be green and its `review` job green or reviewed by the owner.
      Both jobs print `base <B>, head <M>` (`gh run view <id> --repo eve-cyno/plugins --log | grep -m2 'base '`): `<B>` is the
      `main` they checked against, `<M>` GitHub's merge commit of `<B>` and `<H>`.
   3. Fetch the head: `git fetch origin pull/<n>/head`; `git rev-parse FETCH_HEAD` must be `<H>` (no commit was pushed after the run).
   4. `git rev-parse main` and `git rev-parse origin/main` must both be `<B>`. When `main` moved on (an earlier merge was pushed),
      the run checked another base: do not merge; close and reopen the pull request so `check.yml` runs on the current `main`, and
      start again at step 2.
   5. Merge `<H>` with a merge commit (`git merge --no-ff <H>`), then confirm `git rev-parse HEAD^1` is `<B>` and
      `git rev-parse HEAD^2` is `<H>`. While GitHub still serves `<M>` (`git fetch origin pull/<n>/merge`, then
      `git rev-parse FETCH_HEAD` is `<M>`), `git rev-parse HEAD^{tree}` must equal `git rev-parse FETCH_HEAD^{tree}`: the merged
      files are the files the jobs checked. Any difference: `git reset --hard <B>`, and do not push.
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
3. The owner merges it locally at once, as in "Publishing" step 1 (the merged commits are the ones `check.yml` ran on), and dispatches
   `publish.yml` (`target: production`); the owner approves `index` and then
   `mirror`, each after the steps above. The summary's "revocations added" line is a convenience.
4. Apps apply it at their next check (at most 4 hours) or next start; a revoked plugin is disabled at once with a notice and keeps its
   data. The archive stays in the mirror.

**Lifting.** A revocation leaves only through a pull request that deletes it (C15 flags `lift`) and a `publish.yml` run whose `lift`
input names it exactly, one `<id> <versions>` per line; `build` fails otherwise.

## When a run is red

| Where | What it means | What to do |
|---|---|---|
| `Refuse a re-run` step | someone re-ran the run | nothing was built, signed or uploaded by this attempt; dispatch a new run. From then on `approved-base.mjs` and the repair base stop with an ERROR at that run (GitHub lists the latest attempt's jobs only): the owner reads each of its attempts on the run page against his list and finds `<A>` by hand while that run is newer than `<A>` |
| `build` or `head` | a check failed, or the commit is no longer `main`'s head | read the summary; fix through a pull request; dispatch a new run |
| `sign` | the key, passphrase, head checks or signature verification failed | nothing left the job but the error; set the `index` secrets again with the command of "Secrets and variables" and check the head; dispatch a new run |
| `upload`, a 412 | someone changed the live index during the run | stop; find out who wrote it (R2 audit, other runs) before anything else; then dispatch a new run |
| `upload`, other | see the R1 outcome in the job log and summary | below |
| `verify` | the live index does not read back as published | **never re-run**: the coordinator re-checks it locally with `node vendor/eve-cyno-host/scripts/index-verify.mjs --live --archives`; a confirmed failure goes to recovery R2 |

**Recovery R1** (inside `upload`). After a failed or unanswered PUT the job reads the live objects again and ends with a final re-read
and a verification of the pair. Its outcomes:

- **published:** the new pair verifies. The run goes on to `verify`.
- **unchanged** (red): the old pair verifies, or, on a true first publish, both objects are still absent. Nothing was published;
  dispatch a new run. After a first publish this run's `sign` succeeded, so the next run is no first publish: dispatch a repair run
  (recovery R2).
- **FIRST-PUBLISH ORPHAN** (red): a new signature with no head yet. Apps read the missing head as unavailable. This run's `sign`
  succeeded, so the next run is no first publish: a repair run (recovery R2) overwrites the orphan.
- **TEST NOT PUBLISHED** (red, `target: test` only): the new test pair is not live. Dispatch a new test run.
- **REPLAYED** (red): a pair that verifies but is neither new nor old is live: someone else's verified head, possibly an older one.
  Treat it as a security event: no approval of anything until the owner has found out who wrote it; then recovery R2.
- **HALF-PUBLISHED** (red), or a failed restore: the live pair does not verify. Recovery R2, or the owner's manual path (5.4).

## Recovery R2: repair

When the live index does not verify (confirmed locally by the coordinator), the owner dispatches `publish.yml` with
`target: production` and `repair: true`. Its base comes only from verified heads: the `head`, `signature` and `catalog` artifacts of
`<A>` and of every later run whose `sign` succeeded after an approved `index`. Any such run younger than 90 days that lacks one of
those artifacts (or has it expired) **stops the repair**, so a deleted artifact never drops a revocation silently. The unsigned live
head only raises the floor of `generated`. The approvals follow the steps above, step 6 included. If the repair stops, or no candidate
verifies, the owner follows the emergency path.

## Emergency path (plan 5.4)

If `eve-cyno/plugins` or its Actions are unusable, the coordinator re-sets the desktop signing secrets from the backup
(`scripts/desktop-signing-secrets.sh` in the infra repository: it decrypts into tmpfs and pipes each value to `gh secret set` on
stdin; the owner runs no decrypt command). Then the desktop repository's `docs/release-checklist.md`, "The plugin index", is followed
by hand: the coordinator builds with the vendored tools; the owner runs `scripts/release-sign.sh` with purpose `index`, which only
dispatches the desktop `sign.yml` (it signs in CI after his approval, decrypts nothing and reads no secret) and verifies the
signature it downloads; the owner uploads with his own Cloudflare login.

## Rotation (plan 4.4)

As in the desktop repository's `docs/release-checklist.md`, "Key compromise and rotation": the app pins a primary and a standby
index key, and a rotation is an app release that pins the new pair. In addition, for this repository: after
`rotate.sh promote index ...` the new primary goes into the `index` environment of `eve-cyno/plugins` with the command of
"Secrets and variables" (`--repo eve-cyno/plugins`), and the vendor pin moves to the desktop commit with the new `.pub` files
(`node tools/vendor-host.mjs --check` passes). Both index keys lost is not fatal (checklist, "Keys lost, not leaked").

## Measurements

Recorded once, on real runs; until then they are open.

| What | How | Result |
|---|---|---|
| Does a run waiting for approval hold the `index-sign` group? | a `target: test` run waiting at `mirror`, then a second dispatch | not measured yet |
| How long does a pending approval stay open? | the same run, within the 35-day run cap | not measured yet |
| Probe answers of both tokens | `tools/check-envs.mjs` after the token swap | see "The agents' token" |
