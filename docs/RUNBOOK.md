# Runbook: publishing the plugin index

How the index at `plugins.eve-cyno.dev` is published, re-signed, revoked and repaired, and what must be true before anyone approves a
run. The workflows are `.github/workflows/publish.yml`, `resign.yml` and `check.yml`; `tools/test/workflows.test.mjs` holds their
rules (C-WF1 to C-WF11).

Roles:

- **The owner** (his everyday GitHub account) merges, dispatches runs and sets secrets. He never approves a deployment with that
  account; "Prevent self-review" stops it anyway.
- **The reviewer account** approves the environments `index` and `mirror`, after the steps in "Before every index and mirror
  approval". It does nothing else.
- **The coordinator** (an agent) runs `tools/check-envs.mjs`, `tools/approved-base.mjs` and local verifications, and hands their output
  to the reviewer. It never approves a deployment, never dispatches `publish.yml` with `target: production`, and never sets, reads or
  deletes a secret.

**Hard rule.** No private key, passphrase or token ever passes through an agent shell, a file an agent writes, a log or a message.

## Secrets and variables

Names only. The values exist only where the owner puts them.

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

The owner sets them in the GitHub UI (Settings, Environments), or on the release PC with the infra repository's
`scripts/desktop-signing-rotate.sh secrets index index --env index --repo eve-cyno/plugins` (once its `--repo` option exists). After
the first head signed here verifies, the owner deletes the two `MINISIGN_INDEX_*` secrets of `eve-cyno/desktop`; its `sign.yml` purpose
`index` then fails with "a secret of this key is not set" and stays as the emergency path.

## The environments

Both `index` and `mirror` have exactly these settings:

- **Required reviewers:** one, the reviewer account. **Prevent self-review:** on.
- **Allow administrators to bypass configured protection rules:** off (`can_admins_bypass: false`).
- **Deployment branches and tags:** selected branches, one rule: the branch `main` (not a tag).
- No wait timer and no custom protection rule (`tools/check-envs.mjs` fails on any rule type other than the reviewer and branch rules).

Repository setting: Settings, Actions, General, "Artifact and log retention" stays at 90 days. The workflows ask for 90 days on the
`head`, `signature` and `catalog` artifacts, and GitHub caps every artifact at the repository setting; recovery R2 needs them.

## The reviewer account

- It is a separate GitHub account. No credential of it exists on the workstation where agents run: the owner signs in to it only in
  a browser profile or on his phone, with 2FA, never with `gh auth login` and never with a personal access token on that machine.
- The owner's everyday account dispatches; the reviewer account approves. With "Prevent self-review" on, neither can do both.
- Its numeric GitHub user id (not the login) is in `tools/reviewer.json`, as `{"reviewerId": <id>}`. The id is public
  (`https://api.github.com/users/<login>`, field `id`). The committed file is a placeholder that every tool refuses; the owner replaces
  it through a pull request. No workflow and no other tool may take the id from anywhere else (static rule C-WF11); the tools read
  the file **as committed at the run's commit** (`git show <B>:tools/reviewer.json`), never from a local checkout.
- **Owner's written confirmation** (once): "No credential of the reviewer account exists on the agents' workstation, and none will."
  Confirmed on: _(date, owner)_.

## The agents' token (owner decision Q16, part "token")

- **T1 (recommended):** agents' `gh` calls use a fine-grained token with **no Administration and no Actions write** on
  `eve-cyno/plugins` and no organization administration; the everyday token with admin rights stays off the agents' shells. Every
  dispatch, test runs included, is the owner's.
- **T2:** the owner keeps the current token and accepts the residuals: an agent could rewrite an environment, and could delete runs
  or artifacts that the first-publish rule and recovery R2 read.
- Under both, the reviewer's own list (below) and R2's stop rule for missing artifacts are the checks against deleted runs: T1 only
  removes the direct path, because a workflow pushed to `main` can still ask for `actions: write`.
- Decision: _(T1 or T2, date, owner)_.

`tools/check-envs.mjs` probes the agents' token under T1 (the default). Under T2 it runs with `--t2` and says that no probe was sent.

Probe answers, recorded once after the token swap (fill in; until then they are not measured):

| Token | `GET repos/eve-cyno/plugins/keys` | `DELETE repos/eve-cyno/plugins/actions/artifacts/1` |
|---|---|---|
| agents' fine-grained token (expected: 403 for both) | not measured yet | not measured yet |
| everyday token (expected: 404 on the second; it can delete) | not measured yet | not measured yet |

If the agents' token gets 404 on the second probe, the T1 check always fails closed and the coordinator decides.

## Before every index and mirror approval

This comes before **every** approval of `index` or `mirror`: both workflows, both targets (a `target: test` run has a `mirror`
approval only). The reviewer does it in the browser, signed in as the reviewer account. `<B>` is the run's single commit
(`github.sha`, shown on the run page).

1. **Settings.** The coordinator has run, for this run, with `<B>` fetched into its checkout:

   ```
   node tools/check-envs.mjs --rev <B> --repo-dir <checkout>
   ```

   and it printed `C-ENV1 PASS` (exit 0). It checks both environments, that the required reviewer equals the id committed at `<B>`
   and differs from the token's own account, and, under T1, that both probes answer exactly HTTP 403 with the message "Resource not
   accessible by personal access token" and an `x-ratelimit-remaining` above 0. Any other answer fails. A pass is not proof that
   nothing changed between the check and the approval; that rests on the owner's rules above.
2. **Find `<A>`, the last approved base.** `<A>` is the commit of the newest run of `publish.yml` or `resign.yml`, **other than the
   run under review**, that has an approval of `index` by the reviewer account and whose `sign` and `upload` jobs both concluded
   `success`. Not the newest green run: a no-op re-sign ends green at `check`, a scheduled run takes `main`'s head, and a
   `target: test` run has no `index` approval. The coordinator runs:

   ```
   node tools/approved-base.mjs --run <run id> --repo-dir <checkout>
   ```

   It prints `<B>`, one `skip` line per newer run with the reason, `<A>` with its run, the compare status and the compare link. Exit
   0: `<A>` found, status `ahead` or `identical`; 1: `NO APPROVAL` or `ERROR` (a failed request or an incomplete list is an error,
   never "no approved run"); 3: `FIRST PUBLISH` (step 4). The tool is a convenience: confirm on `<A>`'s run page that the `index`
   approval shown is the reviewer account's own.
3. **Check against your own list.** GitHub's run history can be deleted by anyone with Actions write, so the reviewer keeps a list
   outside GitHub and outside the workstation (for example a note on the phone), one entry per **production `index` approval**:

   | run id | workflow | commit | head `generated` | `sign` | `upload` |
   |---|---|---|---|---|---|

   Write the first four at the `index` approval (the `generated` from the run summary, after step 5), and the outcome of `sign` and
   `upload` after the run. Test runs are not entries; refused approvals and failed runs are entries only as far as they got.
   **No approval** when: `<A>` is not the newest entry of the list whose `sign` and `upload` both succeeded (the run under review
   aside); a run of the list no longer shows on GitHub; or the live base (the verified live head, or R2's base) has a `generated` older
   than that newest entry's (an older verified head was replayed).
4. **First publish only** (the tool says `FIRST PUBLISH`, there is no `<A>`): allowed only while no entry of your list has a
   successful `upload`. After such an entry, a run that calls itself a first publish means **no approval**. Read every file outside
   `entries/**` and `revoked.json` at `<B>` (or the compare view from the repository's root commit to `<B>`), `package-lock.json`
   included, and `vendor/` against the coordinator's `node tools/vendor-host.mjs --check --from <desktop checkout> --rev <pinned
   commit>` output.
5. **Check the direction, then read the change.** The compare status of `<A>` to `<B>` must be `ahead` or `identical`; `behind` or
   `diverged` means **no approval**. Then read `https://github.com/eve-cyno/plugins/compare/<A>...<B>`: **every change outside
   `entries/**` and `revoked.json`** (workflows, tools, vendor, `package.json`, `package-lock.json`, any `.npmrc`, schemas, docs),
   because `npm ci` in `build` and `upload` runs what the manifest and lock file name, with the `mirror` secrets in `upload`. Read the
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

1. The environments exist with the settings above; the reviewer account exists; the written confirmation above is filled in.
2. `tools/reviewer.json` holds the reviewer account's real id (merged through a pull request; never the placeholder).
3. The token decision is made. Under T1: the token is swapped, `tools/check-envs.mjs` passes, and the probe table above is filled in.
4. The secrets and variables are set (owner only).
5. **Pinned actions.** Every `uses:` still marked `@TODO-PIN` (`actions/setup-node`, `actions/download-artifact`) gets the full
   40-hex commit SHA of a reviewed release, with the version in a comment, and `EVECYNO_PIN_STRICT=1 npm test` passes (by default the
   static tests only report the open pins as a todo).
6. **Vendor.** The vendored host is re-made from the current desktop `main` that holds the index scripts' new options, and
   `EVECYNO_VENDOR_STRICT=1 npm test` and `node tools/vendor-host.mjs --check --from <desktop checkout> --rev <that commit>` pass.
7. **Free tier.** The R2 free-tier table (storage, Class A, Class B headroom) in the infra repository's hosting runbook is filled in
   from the Cloudflare dashboard. The first production publish waits for it. Anything that would leave the free tier goes to the
   owner first; the owner looks at the bucket's R2 metrics once a month.
8. **Q10, no empty head.** The first production head goes out with the first approved entry, never empty: any verified head shows the
   Marketplace to every product build.
9. **The coordinator's OK for the schedule** of `resign.yml` on this public repository. If refused, `resign.yml` keeps only
   `workflow_dispatch`, and the uptime alarm plus a monthly item of this runbook replace the schedule.

## First test publish (Phase 2 proof)

The owner dispatches `publish.yml` with `target: test`. `build` uses the prefix `https://plugins.eve-cyno.dev/test/v1/`, `sign-test`
(no environment) signs with a throwaway key made in the run, and `upload` writes under `test/v1/` after the reviewer's `mirror`
approval (steps above). The app never reads `test/v1/`. Record from this run, in "Measurements" below: whether a run waiting for
approval holds the `index-sign` group, and how long a pending approval stays open.

## Publishing

1. Merge the entry pull requests locally on `main`.
2. The owner dispatches `publish.yml` with `target: production` (`lift` empty unless a revocation is being lifted; `repair` false).
3. `build` checks against the live base and prints the head's bytes and SHA-256 in the summary. Approve `index` only after the steps
   above; then `mirror`, after them again.
4. After the run, add the outcome of `sign` and `upload` to your list.

Every run has one commit (`github.sha`); `build` fails if that commit is no longer the head of `main`. **No run is ever re-run**, not
even its failed jobs: the first step of every job fails on any attempt but the first. Dispatch a new run.

## Re-sign

- `resign.yml` runs every Monday at 06:17 UTC and can be dispatched. Its `check` job reads the live head and ends the run (green, no
  approval asked) unless the head is 30 days old or more, or fewer than 30 days remain before it expires. Otherwise `head` makes a new
  head with the same catalog and a new `generated` (60 days), and `sign` and `upload` need the reviewer's approvals of `index` and
  `mirror`, each after the steps above.
- `resign.yml` never repairs: when the live head does not verify, `head` fails with a pointer to recovery R2.
- GitHub disables scheduled workflows in a public repository after 60 days without repository activity, and a re-sign makes no
  commit. The uptime alarm posts to Discord `#deploy-log` when fewer than 21 days remain. Then the owner re-enables the workflow
  (Actions tab, `resign`, "Enable workflow") and dispatches it.

## Revocation

1. A report arrives (Discord, in-game, or a finding of ours).
2. The owner, or a maintainer acting for him, opens a pull request `revoke <id> <versions>` with the entry in `revoked.json`; check C15
   reads it.
3. The owner merges it locally at once and dispatches `publish.yml` (`target: production`); the reviewer approves `index` and then
   `mirror`, each after the steps above. The summary's "revocations added" line is a convenience.
4. Apps apply it at their next check (at most 4 hours) or next start; a revoked plugin is disabled at once with a notice and keeps its
   data. The archive stays in the mirror.

**Lifting.** A revocation leaves only through a pull request that deletes it (C15 flags `lift`) and a `publish.yml` run whose `lift`
input names it exactly, one `<id> <versions>` per line; `build` fails otherwise.

## When a run is red

| Where | What it means | What to do |
|---|---|---|
| `Refuse a re-run` step | someone re-ran the run | nothing was built, signed or uploaded by this attempt; dispatch a new run |
| `build` or `head` | a check failed, or the commit is no longer `main`'s head | read the summary; fix through a pull request; dispatch a new run |
| `sign` | the key, passphrase, head checks or signature verification failed | nothing left the job but the error; check the secrets (owner) and the head; dispatch a new run |
| `upload`, a 412 | someone changed the live index during the run | stop; find out who wrote it (R2 audit, other runs) before anything else; then dispatch a new run |
| `upload`, other | see the R1 outcome in the job log and summary | below |
| `verify` | the live index does not read back as published | **never re-run**: the coordinator re-checks it locally with `node vendor/eve-cyno-host/scripts/index-verify.mjs --live --archives`; a confirmed failure goes to recovery R2 |

**Recovery R1** (inside `upload`). After a failed or unanswered PUT the job reads the live objects again and ends with a final re-read
and a verification of the pair. Its outcomes:

- **published:** the new pair verifies. The run goes on to `verify`.
- **unchanged** (red): the old pair verifies, or, on a true first publish, both objects are still absent. Nothing was published;
  dispatch a new run.
- **FIRST-PUBLISH ORPHAN** (red): a new signature with no head yet. Apps read the missing head as unavailable; the next run overwrites
  the orphan. Dispatch a new run.
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

If `eve-cyno/plugins` or its Actions are unusable, the owner re-sets the desktop secrets from the backup
(`desktop-signing-secrets.sh` in the infra repository) and follows the desktop repository's `docs/release-checklist.md`, "The plugin
index", by hand: build with the vendored tools, `release-sign.sh` with purpose `index`, upload with his own Cloudflare login.

## Rotation (plan 4.4)

As in the desktop repository's `docs/release-checklist.md`, "Key compromise and rotation": the app pins a primary and a standby
index key, and a rotation is an app release that pins the new pair. In addition, for this repository: after
`rotate.sh promote index ...` the owner sets the new primary into the `index` environment of `eve-cyno/plugins` (`--repo`), and the
vendor pin moves to the desktop commit with the new `.pub` files (`node tools/vendor-host.mjs --check` passes). Both index keys lost
is not fatal (checklist, "Keys lost, not leaked").

## Measurements

Recorded once, on real runs; until then they are open.

| What | How | Result |
|---|---|---|
| Does a run waiting for approval hold the `index-sign` group? | a `target: test` run waiting at `mirror`, then a second dispatch | not measured yet |
| How long does a pending approval stay open? | the same run, within the 35-day run cap | not measured yet |
| Probe answers of both tokens | `tools/check-envs.mjs` after the token swap | see "The agents' token" |
