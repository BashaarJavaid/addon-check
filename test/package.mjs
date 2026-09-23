// Verify the actual package bin from a fresh installation, never the checkout's dist.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fixture, fixtureCase} from '../examples/fixture.mjs';

function command(file, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, options);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolveResult({code, stdout, stderr}));
  });
}
const artifact = process.argv[2];
assert.ok(artifact, 'Pass a reviewed tarball path or addon-check@0.1.0');
const dir = await mkdtemp(join(tmpdir(), 'addon-check-package-'));
try {
  const installed = await command('npm', ['install', '--ignore-scripts', '--prefix', dir, artifact.endsWith('.tgz') ? resolve(artifact) : artifact]);
  assert.equal(installed.code, 0, installed.stderr);
  const bin = join(dir, 'node_modules/.bin/addon-check');
  const cases = join(dir, 'cases.json');
  await writeFile(cases, JSON.stringify({version: 1, cases: [fixtureCase(), fixtureCase('write_once')]}), {mode: 0o600});
  for (const broken of [false, true]) {
    const server = await fixture(broken ? {words: 75} : {});
    try {
      const result = await command(bin, [server.url, '--cases', cases, '--token-env', 'FIXTURE_TOKEN', '--require-complete', '--json'], {cwd: dir, env: {...process.env, FIXTURE_TOKEN: 'synthetic-token'}});
      assert.equal(result.code, broken ? 1 : 0, result.stdout + result.stderr);
      const parsed = JSON.parse(result.stdout);
      if (broken) assert.ok(parsed.checks.some(c => c.id === 'speech.estimate' && c.status === 'FAIL'));
      else assert.equal(parsed.summary.complete, true);
      console.log(`PASS installed package: ${broken ? 'broken fixture exits 1 with speech.estimate' : 'complete fixture exits 0'}; ${artifact}`);
    } finally {await server.close();}
  }
} finally {await rm(dir, {recursive: true, force: true});}
