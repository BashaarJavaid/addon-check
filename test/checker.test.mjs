import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fixture, fixtureCase} from '../examples/fixture.mjs';
import {run, exitCode, ConfigError} from '../dist/checker.js';
import {compile, casesFile, speech, speechMetrics, latencyPass, UnsupportedSchema} from '../dist/schema.js';
import {endpoint} from '../dist/transport.js';

const cases = () => [fixtureCase(), fixtureCase('write_once')];
async function check(t, options = {}, entries = cases()) {
  const server = await fixture(options);
  t.after(server.close);
  return {result: await run(new URL(server.url), entries, 'synthetic-token'), server};
}
const status = (result, id, value) => result.checks.some(c => c.id === id && c.status === value);

for (const sse of [false, true]) test(`complete CLI contract over ${sse ? 'SSE' : 'JSON'}`, async t => {
  const {result, server} = await check(t, {sse, pagination: 'valid'});
  assert.equal(result.summary.status, 'PASS', JSON.stringify(result));
  assert.equal(exitCode(result, true), 0);
  assert.deepEqual(result.summary.timedTools, ['read_context']);
  assert.equal(server.state.calls.length, 24); // 2 explicit auth probes + warm-up + 20 + one mutation.
  assert.equal(server.state.calls.filter(c => c.name === 'write_once').length, 1);
  assert.equal(result.checks.find(c => c.id === 'latency.measured').metrics.measuredCalls, 20);
  assert.equal(server.state.requests.some(r => r.method === 'GET' && r.path === '/mcp'), false);
  assert.equal(server.state.requests.filter(r => r.path.startsWith('/.well-known')).some(r => r.authorization), false);
  assert.equal(server.state.requests.filter(r => r.path === '/mcp').every(r => r.protocol === '2025-11-25'), true);
});
test('URL-only discovers but never calls; require-complete exits 2', async t => {
  const {result, server} = await check(t, {}, []);
  assert.equal(server.state.calls.length, 0);
  assert.equal(result.summary.complete, false);
  assert.equal(exitCode(result, false), 0);
  assert.equal(exitCode(result, true), 2);
  assert.ok(status(result, 'evidence.tool', 'SKIP'));
});
for (const [options, id] of [
  [{protocol: '2025-03-26'}, 'transport.discovery'],
  [{wrongId: true}, 'transport.discovery'],
  [{badJson: true}, 'transport.discovery'],
  [{oversized: true}, 'transport.discovery'],
  [{largeHeader: true}, 'transport.discovery'],
  [{missingContent: true}, 'case.result'],
  [{pagination: 'repeat'}, 'transport.discovery'],
  [{pagination: 'endless'}, 'transport.discovery'],
  [{badResource: true}, 'auth.metadata'],
  [{noS256: true}, 'auth.metadata'],
  [{badChallenge: true}, 'auth.probe.missing'],
  [{bad401: true}, 'auth.probe.malformed'],
  [{public: true}, 'auth.probe.missing'],
  [{outputMismatch: true}, 'case.output'],
  [{malformed: true}, 'case.result'],
  [{words: 75}, 'speech.estimate'],
  [{speech: 'A | table'}, 'speech.formatting'],
  [{ui: 'broken'}, 'ui.resource'],
  [{ui: 'bad-meta'}, 'ui.resource'],
  [{ui: 'bad-resource-meta'}, 'ui.resource'],
]) test(`broken variant ${JSON.stringify(options)}`, async t => {
  const {result} = await check(t, options);
  assert.ok(status(result, id, 'FAIL'), JSON.stringify(result));
  assert.equal(exitCode(result, true), 1);
  assert.equal(JSON.stringify(result).includes('secret payload'), false);
});
test('10-second deadline applies to stalled body/response', {timeout: 15_000}, async t => {
  const start = performance.now();
  const {result} = await check(t, {hang: true}, []);
  assert.ok(status(result, 'transport.discovery', 'FAIL'));
  assert.match(result.checks[0].message, /deadline/);
  assert.ok(performance.now() - start < 12_000);
});
test('redirect is not followed and token remains at exact MCP endpoint', async t => {
  const {result, server} = await check(t, {redirect: true});
  assert.equal(exitCode(result, false), 1);
  assert.equal(server.state.requests.some(r => r.path === '/leak'), false);
  assert.equal(server.state.requests.some(r => r.authorization && r.path !== '/mcp'), false);
});
test('metadata path fallback, 74 words, data-only UI', async t => {
  const {result} = await check(t, {pathFallback: true, words: 74});
  assert.equal(result.summary.status, 'PASS');
  assert.ok(status(result, 'ui.resource', 'PASS'));
  assert.equal(result.checks.some(c => c.id === 'ui.browser'), false);
});
test('UI references are read and browser modes remain manual', async t => {
  const {result} = await check(t, {ui: 'valid'});
  assert.equal(result.summary.status, 'PASS', JSON.stringify(result));
  assert.ok(status(result, 'ui.browser', 'MANUAL'));
});
test('warm-up is excluded; 20 measured samples still required', async t => {
  const {result} = await check(t, {slowWarmup: true});
  assert.equal(result.summary.status, 'PASS');
  assert.ok(result.checks.find(c => c.id === 'latency.warmup').metrics.milliseconds >= 500);
  assert.equal(latencyPass(Array(20).fill(499.999)), true);
  assert.equal(latencyPass([500, ...Array(19).fill(1)]), false);
  assert.equal(latencyPass(Array(19).fill(1)), false);
});
test('one slow measured response fails', async t => {
  const {result} = await check(t, {slow: true});
  assert.ok(status(result, 'latency.measured', 'FAIL'));
});
test('expected error exempt from successful-output schema, never complete evidence', async t => {
  const {result, server} = await check(t, {error: true}, [fixtureCase('write_once', {expectError: true})]);
  assert.ok(status(result, 'case.result', 'PASS'));
  assert.ok(status(result, 'case.output', 'PASS'));
  assert.equal(server.state.calls.length, 1);
  assert.equal(result.summary.complete, false);
});
test('unexpected error fails', async t => {
  const {result} = await check(t, {error: true});
  assert.ok(status(result, 'case.result', 'FAIL'));
});
test('preflight rejects unknown/invalid cases before any call', async t => {
  const server = await fixture(); t.after(server.close);
  for (const entries of [[fixtureCase('unknown')], [fixtureCase(), fixtureCase('write_once', {arguments: {surprise: true}})]]) {
    await assert.rejects(run(new URL(server.url), entries, 'synthetic-token'), ConfigError);
    assert.equal(server.state.calls.length, 0);
  }
});
test('unsupported dialect/ref is untested with no calls', async t => {
  for (const schema of [{type: 'object', $schema: 'https://example.org/schema'}, {type: 'object', $ref: 'https://example.org/data'}]) {
    const {result, server} = await check(t, {inputSchema: schema});
    assert.ok(status(result, 'schema.input', 'SKIP'));
    assert.equal(server.state.calls.length, 0);
    assert.equal(exitCode(result, true), 2);
  }
});
test('malformed schemas fail and no input-schema bypass exists', async t => {
  const {result, server} = await check(t, {inputSchema: {type: 'object', properties: {bad: {type: 'nonsense'}}}});
  assert.ok(status(result, 'schema.input', 'FAIL'));
  assert.equal(server.state.calls.length, 0);
});
test('missing descriptions/output schemas and style warn', async t => {
  const {result} = await check(t, {noDescription: true, noOutput: true, name: 'readContext'}, [fixtureCase('readContext', {authProbe: true, repeatable: true}), fixtureCase('write_once')]);
  assert.equal(result.summary.status, 'PASS');
  for (const id of ['tools.description', 'tools.style', 'schema.output']) assert.ok(status(result, id, 'WARN'));
});
test('local references, draft-07, nullable unions, annotations', () => {
  for (const $schema of [undefined, 'http://json-schema.org/draft-07/schema#']) {
    const validator = compile({type: 'object', ...($schema ? {$schema} : {}), $defs: {entry: {anyOf: [{type: 'string', format: 'not-a-format'}, {type: 'null'}]}}, properties: {value: {$ref: '#/$defs/entry'}}, required: ['value']});
    assert.equal(validator({value: null}), true);
    assert.equal(validator({value: 'not-an-email'}), true);
    assert.equal(validator({value: 3}), false);
  }
  assert.throws(() => compile({type: 'object', $ref: '#/$defs/missing'}));
  assert.throws(() => compile({type: 'object', properties: {a: {$ref: 'https://example.org'}}}), UnsupportedSchema);
  // Data under const is not a schema reference.
  assert.equal(compile({type: 'object', properties: {a: {const: {$ref: 'data'}}}})({a: {$ref: 'data'}}), true);
});
test('explicit fields, pointers, speech boundaries and punctuation', () => {
  assert.throws(() => casesFile({version: 1, cases: [{tool: 'read_context'}]}));
  assert.throws(() => casesFile({version: 1, cases: [fixtureCase('read_context', {speechPointers: ['/~2']})]}));
  assert.deepEqual(speech({'a/b': {'~': ['hello', 'world']}}, ['/a~1b/~0']), ['hello', 'world']);
  for (const value of [3, {}, null, ['word', 5]]) assert.throws(() => speech({x: value}, ['/x']));
  assert.throws(() => speech({x: ['a']}, ['/x/01']));
  assert.throws(() => speech({}, ['/missing']));
  for (const text of ['a | b', '`code`', '[link](https://example.org)', '![image](image)', '# Heading', '- item', '1. item', '**bold**', '_emphasis_', '[label][ref]']) assert.equal(speechMetrics([text]).formatting, true, text);
  for (const text of ['Fine, thanks! ($3.20)', 'It is 7:30 — ready?', 'a_b value', '3 * 4 = 12', 'We’re ready.']) assert.equal(speechMetrics([text]).formatting, false, text);
  assert.equal(speechMetrics([Array(74).fill('a').join(' ')]).estimatedSeconds, 29.6);
  assert.equal(speechMetrics([Array(75).fill('a').join(' ')]).estimatedSeconds, 30);
  for (const url of ['http://example.org/mcp', 'https://user:password@example.org/mcp', 'https://example.org/mcp#fragment', 'file:///tmp/foo']) assert.throws(() => endpoint(url));
});
test('missing/wrong-type returned speech fails', async t => {
  const {result} = await check(t, {}, [fixtureCase('read_context', {speechPointers: ['/missing']})]);
  assert.ok(status(result, 'speech.estimate', 'FAIL'));
});

async function cli(args, env = {}) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('dist/cli.js'), ...args], {env: {...process.env, ...env}});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolveResult({code, stdout, stderr}));
  });
}
test('compiled CLI: pass, broken fixture, incomplete and invalid configuration; no payloads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'addon-check-test-')); t.after(() => rm(dir, {recursive: true}));
  const path = join(dir, 'cases.json'); await writeFile(path, JSON.stringify({version: 1, cases: cases()}), {mode: 0o600});
  for (const [options, expected] of [[{}, 0], [{words: 75}, 1], [{badJson: true}, 1]]) {
    const server = await fixture(options); t.after(server.close);
    const result = await cli([server.url, '--cases', path, '--token-env', 'FIXTURE_TOKEN', '--require-complete', '--json'], {FIXTURE_TOKEN: 'synthetic-token'});
    assert.equal(result.code, expected, result.stdout + result.stderr);
    const parsed = JSON.parse(result.stdout); assert.equal(parsed.version, 1);
    assert.equal(result.stdout.includes('synthetic-token'), false);
    assert.equal(result.stdout.includes('private-payload'), false);
    if (options.words) assert.ok(status(parsed, 'speech.estimate', 'FAIL'));
  }
  const server = await fixture(); t.after(server.close);
  assert.equal((await cli([server.url, '--require-complete', '--json'])).code, 2);
  assert.equal((await cli(['https://u:secret@example.org', '--json'])).code, 2);
  assert.equal((await cli([server.url, '--token-env', 'ABSENT_TOKEN', '--json'], {ABSENT_TOKEN: ''})).code, 2);
  assert.equal((await cli([server.url, '--no-such-option', '--json'])).code, 2);
  const readable = await cli([server.url]); assert.match(readable.stdout, /INCOMPLETE/); assert.equal(readable.code, 0);
});

test('deadline includes streamed response body', {timeout: 15_000}, async t => {
  const {result} = await check(t, {hangBody: true}, []);
  assert.ok(status(result, 'transport.discovery', 'FAIL'));
  assert.match(result.checks[0].message, /deadline/);
});
test('additional case with skipped speech prevents completeness', async t => {
  const {result} = await check(t, {}, [...cases(), fixtureCase('write_once', {speechPointers: []})]);
  assert.equal(exitCode(result, true), 2);
  assert.ok(result.summary.missingEvidence.some(s => s.includes('speech.estimate skipped')));
});
test('discovery is public while explicit protected calls need a bearer', async t => {
  const server = await fixture(); t.after(server.close);
  const result = await run(new URL(server.url), [fixtureCase()], undefined);
  assert.ok(status(result, 'transport.initialize', 'PASS'));
  assert.ok(status(result, 'auth.probe.missing', 'PASS'));
  assert.ok(status(result, 'case.execution', 'FAIL'));
  assert.equal(exitCode(result, true), 1);
});
