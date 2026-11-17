// Real-shape tests of tools/lib/provenance.mjs (check C12). The fixture is a trimmed copy of a real `gh attestation verify
// --format=json` answer (gh 2.104.0, verifying the cli/cli release asset gh_2.104.0_linux_amd64.tar.gz). The subject list is cut
// to three entries and the verified archive is the LAST of them, so the module must search the whole list. `gh` is a stub in a
// temp folder that is the only PATH entry: the real gh is never run, no network, no token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { checkProvenance } from '../lib/provenance.mjs';

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const tempDir = () => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-real-')); temps.push(t); return t; };

const STUB_BIN = tempDir();
fs.writeFileSync(path.join(STUB_BIN, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write(fs.readFileSync(process.env.STUB_STDOUT));
`, { mode: 0o755 });

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/gh-attestation-cli-2.104.0.json', import.meta.url), 'utf8'));
const subjects = FIXTURE[0].verificationResult.statement.subject;
const FIRST_SHA = subjects[0].digest.sha256;
const ARCHIVE_SHA = subjects[2].digest.sha256;
const ARCHIVE = path.join(tempDir(), 'gh_2.104.0_linux_amd64.tar.gz');
fs.writeFileSync(ARCHIVE, 'x');

const ENTRY = { id: 'dev.example.gh', source: 'https://github.com/cli/cli', provenance: { repo: 'cli/cli' } };
const WORKFLOW = '.github/workflows/deployment.yml';

/** A deep copy of the fixture that `edit` may change. */
function mutated(edit) {
  const copy = structuredClone(FIXTURE);
  edit?.(copy[0].verificationResult);
  return copy;
}

async function run({ out = FIXTURE, sha256 = ARCHIVE_SHA, provenance = ENTRY.provenance } = {}) {
  const outFile = path.join(tempDir(), 'stdout');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  return checkProvenance({ entry: { ...ENTRY, provenance }, archive: ARCHIVE, sha256,
    env: { PATH: STUB_BIN, STUB_STDOUT: outFile } });
}
const refused = (result, re) => {
  assert.equal(result.declared, true);
  assert.equal(typeof result.problem, 'string', 'expected a refusal');
  assert.match(result.problem, re);
};

describe('C12 provenance: real gh 2.104.0 answer', () => {
  test('fixture shape: three subjects, the archive is the last, the first is another asset', () => {
    assert.equal(subjects.length, 3);
    assert.notEqual(FIRST_SHA, ARCHIVE_SHA);
    assert.equal(subjects[2].name, 'gh_2.104.0_linux_amd64.tar.gz');
  });

  test('PV-real-valid: accepts the archive that is the third subject, no workflow declared', async () => {
    assert.deepEqual(await run(), { declared: true, problem: null, attestations: 1 });
  });

  test('PV-real-valid-workflow: accepts with the declared workflow deployment.yml', async () => {
    const provenance = { repo: 'cli/cli', workflow: WORKFLOW };
    assert.deepEqual(await run({ provenance }), { declared: true, problem: null, attestations: 1 });
  });

  test('PV-real-subject-search: a hash in the first subject only is not the third, and a hash in no subject refuses', async () => {
    // The first subject's digest is a real subject of the attestation, so the module accepts it: it searches the whole list.
    assert.equal((await run({ sha256: FIRST_SHA })).problem, null);
    // It never trusts subject[0] for another archive: any hash that is in no subject refuses.
    refused(await run({ sha256: 'b'.repeat(64) }), /no subject has the archive SHA-256/);
    // With the verified archive removed from the list, its hash refuses although subject[0] is still there.
    const out = mutated(r => { r.statement.subject = r.statement.subject.slice(0, 2); });
    refused(await run({ out }), /no subject has the archive SHA-256/);
  });

  test('PV-real-repo: a different declared repository refuses', async () => {
    refused(await run({ provenance: { repo: 'cli/other' } }), /not the repository of source/);
    const entryOther = { repo: 'cli/cli' };
    const out = mutated(r => { r.signature.certificate.sourceRepositoryURI = 'https://github.com/evil/cli'; });
    refused(await run({ out, provenance: entryOther }), /source repository/);
  });

  test('PV-real-workflow: a different declared workflow refuses', async () => {
    refused(await run({ provenance: { repo: 'cli/cli', workflow: '.github/workflows/other.yml' } }), /signer workflow/);
  });

  test('PV-real-runner: a runner that is not github-hosted refuses', async () => {
    const out = mutated(r => { r.signature.certificate.runnerEnvironment = 'self-hosted'; });
    refused(await run({ out }), /not github-hosted/);
  });
});
