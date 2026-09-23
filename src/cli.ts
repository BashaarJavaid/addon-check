#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {endpoint, CheckError} from './transport.js';
import {casesFile} from './schema.js';
import {run, report, exitCode, sources, ConfigError, type Report} from './checker.js';

let json = process.argv.includes('--json');
let token: string | undefined;
let result: Report;
let code = 2;
try {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    'token-env': {type: 'string'}, cases: {type: 'string'}, json: {type: 'boolean'},
    'require-complete': {type: 'boolean'}, help: {type: 'boolean'}, version: {type: 'boolean'},
  }});
  json = values.json ?? false;
  if (values.help || values.version) {
    console.log(values.version ? '0.1.0' : 'addon-check <url> [--token-env NAME] [--cases FILE] [--json] [--require-complete]\nCalls require explicit cases. Passing checks are not Amazon certification.');
    process.exit(0);
  }
  if (positionals.length !== 1) throw new ConfigError('Supply exactly one MCP endpoint URL');
  let url: URL;
  try { url = endpoint(positionals[0]!); } catch { throw new ConfigError('Invalid endpoint: use HTTPS or loopback HTTP without credentials or fragment'); }
  if (values['token-env']) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(values['token-env'])) throw new ConfigError('Invalid token environment variable name');
    token = process.env[values['token-env']];
    if (!token || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) throw new ConfigError('Named token environment variable is missing, empty or malformed');
  }
  let cases;
  try { cases = values.cases ? casesFile(JSON.parse(await readFile(values.cases, 'utf8'))) : []; }
  catch { throw new ConfigError('Invalid cases file: use version 1, all six explicit case fields and valid JSON Pointers'); }
  result = await run(url, cases, token);
  code = exitCode(result, values['require-complete'] ?? false);
} catch (error) {
  result = report([{id: 'configuration', status: 'FAIL', source: sources.policy, message: error instanceof CheckError ? error.message : 'Invalid configuration or checker failure; details withheld'}], ['Execution evidence unavailable'], []);
}
let output = json ? JSON.stringify(result, null, 2) : [
  ...result.checks.map(c => `${c.status} ${c.id}${c.tool ? ` [${c.tool}]` : ''}${c.caseIndex !== undefined ? ` case=${c.caseIndex}` : ''}: ${c.message}${c.metrics ? ` ${JSON.stringify(c.metrics)}` : ''}`),
  `${result.summary.status}: ${JSON.stringify(result.summary.counts)}; timed tools: ${result.summary.timedTools.join(', ') || 'none'}`,
  ...result.summary.missingEvidence.map(m => `INCOMPLETE: ${m}`),
  'Scoped evidence only; not Amazon certification.',
].join('\n');
if (token) output = output.replaceAll(token, '[REDACTED]');
console.log(output);
process.exitCode = code;
