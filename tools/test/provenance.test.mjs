// Tests of tools/lib/provenance.mjs (check C12). `gh` is a stub written into a temp folder by this file, and that folder is the
// only entry of PATH the module sees, so the real gh is never found: no network, no token. The stub records its arguments and the
// environment it got, prints a canned answer and exits with a canned code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ISSUER, PREDICATE, attestationArgs, checkProvenance, githubRepoOf, provenanceProblem } from '../lib/provenance.mjs';

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const tempDir = () => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-test-')); temps.push(t); return t; };

const STUB_BIN = tempDir();
fs.writeFileSync(path.join(STUB_BIN, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const e = process.env;
if (e.STUB_CALL) fs.writeFileSync(e.STUB_CALL, JSON.stringify({ argv: process.argv.slice(2), ghHost: e.GH_HOST ?? null,
  prompt: e.GH_PROMPT_DISABLED ?? null, notifier: e.GH_NO_UPDATE_NOTIFIER ?? null }));
if (e.STUB_MODE === 'hang') setTimeout(() => {}, 60000);
else if (e.STUB_MODE === 'flood') process.stdout.write('['.repeat(5 * 1024 * 1024), () => process.exit(0));
else {
  if (e.STUB_STDOUT) process.stdout.write(fs.readFileSync(e.STUB_STDOUT));
  if (e.STUB_STDERR) process.stderr.write(e.STUB_STDERR);
  process.exitCode = Number(e.STUB_EXIT || 0);
}
`, { mode: 0o755 });

const SHA = 'a'.repeat(64);
const REPO = 'example/intel';
const WORKFLOW = '.github/workflows/release.yml';
const ENTRY = Object.freeze({ id: 'dev.example.intel', source: 'https://github.com/example/intel',
  provenance: Object.freeze({ repo: REPO, workflow: WORKFLOW }) });
const ARCHIVE = path.join(tempDir(), 'intel-1.1.0.zip');
fs.writeFileSync(ARCHIVE, 'PK');

/** One element of `gh attestation verify --format json` output, shaped like gh 2.x prints it; `o` overrides single fields. */
function attestation(o = {}) {
  const repo = o.repo ?? REPO;
  const signer = o.signer ?? `https://github.com/${o.signerRepo ?? repo}/${o.workflow ?? WORKFLOW}@refs/tags/v1.1.0`;
  return {
    attestation: { bundle: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' } },
    verificationResult: {
      mediaType: 'application/vnd.dev.sigstore.verificationresult+json;version=0.1',
      signature: { certificate: {
        certificateIssuer: 'CN=sigstore-intermediate,O=sigstore.dev',
        subjectAlternativeName: o.san ?? signer,
        issuer: o.issuer ?? ISSUER,
        githubWorkflowTrigger: 'push',
        githubWorkflowRepository: repo,
        githubWorkflowRef: 'refs/tags/v1.1.0',
        buildSignerURI: signer,
        runnerEnvironment: o.runner ?? 'github-hosted',
        sourceRepositoryURI: o.sourceUri ?? `https://github.com/${repo}`,
        sourceRepositoryRef: 'refs/tags/v1.1.0',
        sourceRepositoryOwnerURI: `https://github.com/${repo.split('/')[0]}`,
        buildConfigURI: signer,
        buildTrigger: 'push',
        sourceRepositoryVisibilityAtSigning: 'public',
      } },
      verifiedTimestamps: [{ type: 'Tlog', uri: 'https://rekor.sigstore.dev', timestamp: '2026-12-01T10:00:00Z' }],
      statement: {
        _type: 'https://in-toto.io/Statement/v1',
        subject: 'subject' in o ? o.subject : [{ name: 'intel-1.1.0.zip', digest: { sha256: SHA } }],
        predicateType: o.predicate ?? PREDICATE,
        predicate: { buildDefinition: {}, runDetails: {} },
      },
    },
  };
}

/** Runs C12 against the stub. `out` is printed as JSON, `text` as it is; `call` is what the stub saw, or null when gh never ran. */
async function run(o = {}) {
  const { entry = ENTRY, out, text, exit = 0, stderr = '', mode = '', env = {}, path: pathVar = STUB_BIN, timeoutMs } = o;
  // Some cases pass undefined on purpose, so these two take no default parameter.
  const archive = 'archive' in o ? o.archive : ARCHIVE;
  const sha256 = 'sha256' in o ? o.sha256 : SHA;
  const dir = tempDir();
  const callFile = path.join(dir, 'call.json');
  const outFile = path.join(dir, 'stdout');
  fs.writeFileSync(outFile, text ?? (out === undefined ? '' : JSON.stringify(out, null, 2) + '\n'));
  const result = await checkProvenance({ entry, archive, sha256, timeoutMs, env: { PATH: pathVar, STUB_CALL: callFile,
    STUB_STDOUT: outFile, STUB_EXIT: String(exit), STUB_STDERR: stderr, STUB_MODE: mode, ...env } });
  const call = fs.existsSync(callFile) ? JSON.parse(fs.readFileSync(callFile, 'utf8')) : null;
  return { result, call };
}
const refused = (result, re) => {
  assert.equal(result.declared, true);
  assert.equal(typeof result.problem, 'string', 'expected a refusal');
  assert.match(result.problem, re);
  assert.doesNotMatch(result.problem, /[\r\n]/, 'a problem is one line (no workflow command can start a line)');
};

const EXPECTED_ARGV = ['attestation', 'verify', '--hostname=github.com', `--repo=${REPO}`,
  `--signer-workflow=github.com/${REPO}/${WORKFLOW}`, `--cert-oidc-issuer=${ISSUER}`, `--predicate-type=${PREDICATE}`,
  '--deny-self-hosted-runners', '--format=json', '--', ARCHIVE];

describe('C12 provenance: verified', () => {
  test('PV-valid: a bound attestation passes; gh gets exactly the fixed argument list', async () => {
    const { result, call } = await run({ out: [attestation()], stderr: 'Loaded digest sha256:aaaa for file://intel-1.1.0.zip\n' });
    assert.deepEqual(result, { declared: true, problem: null, attestations: 1 });
    assert.deepEqual(call.argv, EXPECTED_ARGV);
  });

  test('PV-valid-no-workflow: without a declared workflow any workflow of the same repository passes, no --signer-workflow', async () => {
    const entry = { ...ENTRY, provenance: { repo: REPO } };
    const { result, call } = await run({ entry, out: [attestation({ workflow: '.github/workflows/build.yaml' })] });
    assert.equal(result.problem, null);
    assert.deepEqual(call.argv, EXPECTED_ARGV.filter(a => !a.startsWith('--signer-workflow=')));
  });

  test('PV-repo-case: GitHub names are case-insensitive, so the certificate may carry the canonical case', async () => {
    const { result } = await run({ out: [attestation({ repo: 'Example/Intel' })] });
    assert.equal(result.problem, null);
  });

  test('PV-absent: no provenance declared, gh never runs', async () => {
    const { id, source } = ENTRY;
    const { result, call } = await run({ entry: { id, source }, out: [attestation()] });
    assert.deepEqual(result, { declared: false, problem: null });
    assert.equal(call, null);
  });

  test('PV-env: GH_HOST is dropped and prompts and the update notice are off; the rest of the environment passes', async () => {
    const { result, call } = await run({ out: [attestation()], env: { GH_HOST: 'ghe.example.com' } });
    assert.equal(result.problem, null);
    assert.deepEqual({ ghHost: call.ghHost, prompt: call.prompt, notifier: call.notifier }, { ghHost: null, prompt: '1', notifier: '1' });
  });
});

describe('C12 provenance: bound to source', () => {
  test('PV-source-not-github: provenance with a source that is not a github.com repository link is refused before gh', async () => {
    for (const source of ['https://gitlab.com/example/intel', 'https://github.com/example/intel/', 'https://github.com/example',
      'http://github.com/example/intel', 'https://github.com/example/intel.git/x', 'https://github.com/example/..', undefined]) {
      const { result, call } = await run({ entry: { ...ENTRY, source }, out: [attestation()] });
      refused(result, /source/);
      assert.equal(call, null, `gh ran for source ${source}`);
    }
  });

  test('PV-repo-not-source: provenance.repo other than the source repository is refused before gh', async () => {
    const { result, call } = await run({ entry: { ...ENTRY, provenance: { repo: 'other/intel', workflow: WORKFLOW } }, out: [attestation()] });
    refused(result, /provenance\.repo "other\/intel" is not the repository of source/);
    assert.equal(call, null);
  });

  test('PV-shape: a provenance that is not { repo, workflow? } is refused before gh', async () => {
    for (const provenance of [null, 'example/intel', [], {}, { repo: REPO, workflow: WORKFLOW, extra: 1 }, { repo: REPO, workflow: 7 },
      { repo: REPO, workflow: '.github/workflows/sub/release.yml' }, { repo: REPO, workflow: 'release.yml' }]) {
      const { result, call } = await run({ entry: { ...ENTRY, provenance }, out: [attestation()] });
      refused(result, /provenance/);
      assert.equal(call, null, `gh ran for ${JSON.stringify(provenance)}`);
    }
  });
});

describe('C12 provenance: the answer is bound to the entry', () => {
  test('PV-wrong-repo: an attestation from another source repository is refused', async () => {
    const { result } = await run({ out: [attestation({ sourceUri: 'https://github.com/evil/intel' })] });
    refused(result, /source repository "https:\/\/github\.com\/evil\/intel" is not example\/intel/);
  });

  test('PV-wrong-signer-repo: a workflow of another repository (a reusable workflow) or another host is refused', async () => {
    refused((await run({ out: [attestation({ signerRepo: 'evil/tools' })] })).result, /signer/);
    const signer = `https://ghe.example.com/${REPO}/${WORKFLOW}@refs/tags/v1.1.0`;
    refused((await run({ out: [attestation({ signer })] })).result, /signer/);
  });

  test('PV-wrong-workflow: another workflow, or one that only shares the regex prefix gh checks, is refused', async () => {
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml.yml', '.github/workflows/releaseXyml']) {
      const { result } = await run({ out: [attestation({ workflow })] });
      refused(result, /signer workflow/);
    }
    const entry = { ...ENTRY, provenance: { repo: REPO } };
    refused((await run({ entry, out: [attestation({ workflow: 'scripts/release.yml' })] })).result, /signer workflow/);
  });

  test('PV-san: a SubjectAlternativeName other than the build signer is refused', async () => {
    const { result } = await run({ out: [attestation({ san: `https://github.com/${REPO}/.github/workflows/ci.yml@refs/heads/main` })] });
    refused(result, /SubjectAlternativeName/);
  });

  test('PV-self-hosted: an attestation made on a self-hosted runner is refused', async () => {
    const { result } = await run({ out: [attestation({ runner: 'self-hosted' })] });
    refused(result, /runner/);
  });

  test('PV-issuer: a certificate from another OIDC issuer is refused', async () => {
    const { result } = await run({ out: [attestation({ issuer: 'https://accounts.example.com' })] });
    refused(result, /issuer/);
  });

  test('PV-predicate: another predicate type is refused', async () => {
    const { result } = await run({ out: [attestation({ predicate: 'https://example.com/predicate/v1' })] });
    refused(result, /predicate/);
  });

  test('PV-subject: an attestation whose subjects do not hold the archive SHA-256 is refused', async () => {
    for (const subject of [[{ name: 'x.zip', digest: { sha256: 'b'.repeat(64) } }], [], undefined, [null]]) {
      const { result } = await run({ out: [attestation({ subject })] });
      refused(result, /SHA-256/);
    }
  });

  test('PV-mixed: every attestation in the answer must be bound; one bad one refuses', async () => {
    const { result } = await run({ out: [attestation(), attestation({ sourceUri: 'https://github.com/evil/intel' })] });
    refused(result, /attestation 2 of 2/);
  });

  test('PV-unicode-fold: a certificate name that only folds to the repository (Kelvin sign U+212A lowercases to k) is refused', async () => {
    const entry = { ...ENTRY, source: 'https://github.com/example/kit', provenance: { repo: 'example/kit', workflow: WORKFLOW } };
    assert.equal('example/Kit'.toLowerCase(), 'example/kit');
    const { result } = await run({ entry, out: [attestation({ repo: 'example/kit', sourceUri: 'https://github.com/example/Kit' })] });
    refused(result, /source repository/);
  });
});

describe('C12 provenance: fail closed on gh', () => {
  test('PV-missing-attestation: gh exits 1 with no attestation; the reason names gh\'s message on one line', async () => {
    const { result } = await run({ exit: 1, stderr: 'Error: failed to fetch attestations\nno attestations found\n' });
    refused(result, /^gh attestation verify exited 1: Error: failed to fetch attestations no attestations found$/);
  });

  test('PV-empty: gh exits 0 with an empty array or nothing', async () => {
    refused((await run({ out: [] })).result, /no verified attestation/);
    refused((await run({ text: '' })).result, /not one JSON value/);
  });

  test('PV-nonzero-exit: a non-zero exit refuses even with a valid answer on stdout', async () => {
    const { result } = await run({ out: [attestation()], exit: 2 });
    refused(result, /exited 2/);
  });

  test('PV-malformed-json: broken JSON, a non-array, or an element without a certificate is refused', async () => {
    refused((await run({ text: '[{"verificationResult": ' })).result, /not one JSON value/);
    refused((await run({ out: { verificationResult: attestation().verificationResult } })).result, /not a JSON array/);
    refused((await run({ out: [{ verificationResult: { statement: {} } }] })).result, /no certificate/);
    refused((await run({ out: [null] })).result, /no certificate/);
  });

  test('PV-extra-output: any text before or after the one JSON array on stdout is refused', async () => {
    const good = JSON.stringify([attestation()]);
    for (const text of [`${good}\nVerified!\n`, `Loaded 1 attestation\n${good}\n`, `${good}\n${good}\n`, `﻿${good}`]) {
      refused((await run({ text })).result, /not one JSON value/);
    }
  });

  test('PV-timeout: a gh that does not finish is killed and refused', async () => {
    const { result } = await run({ mode: 'hang', timeoutMs: 300 });
    refused(result, /did not finish/);
  });

  test('PV-output-limit: more output than the limit is refused', async () => {
    const { result } = await run({ mode: 'flood' });
    refused(result, /output limit/);
  });

  test('PV-gh-missing: no gh on PATH is refused, never skipped', async () => {
    const { result } = await run({ path: tempDir(), out: [attestation()] });
    refused(result, /gh not found/);
  });
});

describe('C12 provenance: argument injection', () => {
  test('PV-inject-fields: entry fields shaped like flags are refused before gh', async () => {
    const cases = [
      { source: 'https://github.com/--owner=evil/x', provenance: { repo: '--owner=evil/x' } },
      { source: 'https://github.com/-R/x', provenance: { repo: '-R/x' } },
      { source: 'https://github.com/example/--bundle=x', provenance: { repo: 'example/--bundle=x' } },
      { source: ENTRY.source, provenance: { repo: REPO, workflow: '--bundle=/tmp/x.jsonl' } },
      { source: ENTRY.source, provenance: { repo: REPO, workflow: '.github/workflows/x.yml --no-public-good' } },
      { source: 'https://github.com/example/intel --owner x', provenance: { repo: 'example/intel --owner x' } },
    ];
    for (const { source, provenance } of cases) {
      const { result, call } = await run({ entry: { ...ENTRY, source, provenance }, out: [attestation()] });
      refused(result, /provenance|source/);
      assert.equal(call, null, `gh ran for ${JSON.stringify(provenance)}`);
    }
  });

  test('PV-inject-archive: an archive that is not an absolute path (a flag, oci://, relative) is refused before gh', async () => {
    for (const archive of ['--bundle-from-oci', '-b', 'oci://ghcr.io/evil/x', 'intel.zip', '', undefined]) {
      const { result, call } = await run({ archive, out: [attestation()] });
      refused(result, /archive/);
      assert.equal(call, null, `gh ran for archive ${archive}`);
    }
  });

  test('PV-inject-sha: a SHA-256 that is not 64 lower hex is refused before gh', async () => {
    for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), undefined]) {
      const { result, call } = await run({ sha256, out: [attestation()] });
      refused(result, /SHA-256/);
      assert.equal(call, null);
    }
  });

  test('PV-argv-shape: each value is one --flag=value word and the archive is the only word after --', () => {
    const archive = path.join(path.sep, 'x', '-dash.zip');
    const argv = attestationArgs(archive, { repo: REPO, workflow: WORKFLOW });
    const end = argv.indexOf('--');
    assert.deepEqual(argv.slice(end + 1), [archive]);
    assert.equal(argv.lastIndexOf('--'), end);
    for (const a of argv.slice(2, end)) assert.match(a, /^--[a-z-]+(=\S+)?$/);
  });
});

describe('C12 provenance: helpers', () => {
  test('githubRepoOf takes only https://github.com/<owner>/<name>', () => {
    assert.equal(githubRepoOf('https://github.com/example/intel'), 'example/intel');
    assert.equal(githubRepoOf('https://github.com/a-b/c.d_e-f'), 'a-b/c.d_e-f');
    for (const s of ['https://github.com/example/intel?x', 'https://github.com/example/intel#x', 'https://user@github.com/example/intel',
      'https://github.com.evil/example/intel', 'https://github.com/-x/intel', 'https://github.com/example/.', 'https://github.com/example/-x',
      `https://github.com/${'a'.repeat(40)}/x`, 'https://GITHUB.com/example/intel', 7, null]) {
      assert.equal(githubRepoOf(s), null, `${s}`);
    }
  });

  test('provenanceProblem is null without provenance and for a bound one', () => {
    assert.equal(provenanceProblem({ source: 'https://gitlab.com/x/y' }), null);
    assert.equal(provenanceProblem(ENTRY), null);
  });
});
