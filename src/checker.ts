import { InitializeResultSchema, ListToolsResultSchema, CallToolResultSchema, ReadResourceResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';
import { Transport, endpoint, metadata, HttpError, CheckError, PROTOCOL } from './transport.js';
import { compile, object, speech, speechMetrics, latencyPass, UnsupportedSchema, type Case } from './schema.js';

export const sources = {
  transport: {kind: 'MCP requirement', url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports'},
  tools: {kind: 'MCP requirement', url: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools'},
  auth: {kind: 'MCP requirement', url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization'},
  latency: {kind: 'Amazon guidance', url: 'https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html'},
  speech: {kind: 'Amazon guidance', url: 'https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html'},
  apps: {kind: 'MCP Apps requirement', url: 'https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx'},
  policy: {kind: 'Project policy', url: 'https://github.com/BashaarJavaid/addon-check#scope-and-sources'},
} as const;
export type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'MANUAL';
export interface Check {
  id: string; status: Status; source: typeof sources[keyof typeof sources];
  tool?: string; caseIndex?: number; message: string; metrics?: Record<string, unknown>;
}
export interface Report {
  version: 1;
  summary: {status: 'PASS' | 'FAIL' | 'INCOMPLETE'; complete: boolean; counts: Record<Status, number>; timedTools: string[]; missingEvidence: string[]};
  checks: Check[];
}
export class ConfigError extends CheckError {}
export function report(checks: Check[], missingEvidence: string[], timedTools: string[]): Report {
  const counts = {PASS: 0, FAIL: 0, WARN: 0, SKIP: 0, MANUAL: 0};
  for (const check of checks) counts[check.status]++;
  return {version: 1, summary: {status: counts.FAIL ? 'FAIL' : missingEvidence.length ? 'INCOMPLETE' : 'PASS', complete: !missingEvidence.length && !counts.FAIL, counts, timedTools: [...new Set(timedTools)], missingEvidence}, checks};
}
export function exitCode(result: Report, requireComplete: boolean): number {
  return result.summary.counts.FAIL ? 1 : requireComplete && !result.summary.complete ? 2 : 0;
}
function safeError(error: unknown): string { return error instanceof CheckError ? error.message : 'Validation failed; private details withheld'; }
function challenge(value: string | null): Map<string, string> {
  if (!value || !/^Bearer\s/i.test(value)) throw new CheckError('Missing Bearer WWW-Authenticate challenge');
  const fields = new Map<string, string>();
  let rest = value.replace(/^Bearer\s+/i, '');
  while (rest) {
    const part = /^([\w-]+)=(?:"([^"\\]*)"|([^,\s]+))\s*(?:,\s*|$)/.exec(rest);
    if (!part || !part[1] || fields.has(part[1].toLowerCase())) throw new CheckError('Malformed Bearer challenge');
    fields.set(part[1].toLowerCase(), part[2] ?? part[3] ?? '');
    rest = rest.slice(part[0].length);
  }
  return fields;
}
function discoveryUrls(issuer: URL): URL[] {
  const path = issuer.pathname.replace(/\/$/, '');
  return [...new Set([
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ])].map(endpoint);
}
async function authorization(url: URL, prmUrls: Set<string>): Promise<void> {
  const path = url.pathname.replace(/\/$/, '');
  const defaults = [`${url.origin}/.well-known/oauth-protected-resource${path}`, `${url.origin}/.well-known/oauth-protected-resource`];
  const candidates = prmUrls.size ? [...prmUrls] : [...new Set(defaults)];
  for (let i = 0; i < candidates.length; i++) {
    let prm: unknown;
    try { prm = await metadata(endpoint(candidates[i]!)); }
    catch (error) {
      if (!prmUrls.size && error instanceof HttpError && [404, 405].includes(error.status) && i < candidates.length - 1) continue;
      throw error;
    }
    if (!object(prm) || prm.resource !== url.href || !Array.isArray(prm.authorization_servers) || !prm.authorization_servers.length || !prm.authorization_servers.every(s => typeof s === 'string')) throw new CheckError('PRM must identify this exact resource and at least one authorization server');
    if (prm.scopes_supported !== undefined && (!Array.isArray(prm.scopes_supported) || !prm.scopes_supported.every(s => typeof s === 'string'))) throw new CheckError('Invalid PRM scopes_supported');
    for (const name of prm.authorization_servers as string[]) {
      const issuer = endpoint(name);
      if (issuer.search) throw new CheckError('Authorization issuer must not contain a query');
      let document: unknown;
      const urls = discoveryUrls(issuer);
      for (let n = 0; n < urls.length; n++) {
        try { document = await metadata(urls[n]!); break; }
        catch (error) {
          if (!(error instanceof HttpError && [404, 405].includes(error.status) && n < urls.length - 1)) throw error;
        }
      }
      if (!object(document) || document.issuer !== name || typeof document.authorization_endpoint !== 'string' || typeof document.token_endpoint !== 'string' || !Array.isArray(document.response_types_supported) || !document.response_types_supported.includes('code') || !Array.isArray(document.code_challenge_methods_supported) || !document.code_challenge_methods_supported.includes('S256')) throw new CheckError('Authorization metadata requires matching issuer, endpoints, code response and S256');
      endpoint(document.authorization_endpoint); endpoint(document.token_endpoint);
    }
    if (!prmUrls.size) break;
  }
}
function uiMetadata(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.domain !== undefined && typeof value.domain !== 'string') return false;
  if (value.prefersBorder !== undefined && typeof value.prefersBorder !== 'boolean') return false;
  if (value.csp !== undefined) {
    if (!object(value.csp)) return false;
    for (const key of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains']) {
      const list = value.csp[key];
      if (list !== undefined && (!Array.isArray(list) || !list.every(v => typeof v === 'string'))) return false;
    }
  }
  if (value.permissions !== undefined) {
    if (!object(value.permissions)) return false;
    for (const key of ['camera', 'microphone', 'geolocation', 'clipboardWrite']) {
      if (value.permissions[key] !== undefined && (!object(value.permissions[key]) || Object.keys(value.permissions[key]).length)) return false;
    }
  }
  return true;
}

export async function run(url: URL, cases: Case[], token?: string): Promise<Report> {
  const checks: Check[] = [];
  const missing: string[] = [];
  const timed: string[] = [];
  const covered = new Set<string>();
  const authorizedProbes = new Set<number>();
  const successfulCases = new Set<number>();
  const prmUrls = new Set<string>();
  const transport = new Transport(url, token);
  const add = (id: string, status: Status, source: Check['source'], message: string, extra: Partial<Pick<Check, 'tool' | 'caseIndex' | 'metrics'>> = {}) => checks.push({id, status, source, message, ...extra});
  const tools: Tool[] = [];
  try {
    const initialized = InitializeResultSchema.safeParse(await transport.request('initialize', {protocolVersion: PROTOCOL, capabilities: {extensions: {'io.modelcontextprotocol/ui': {mimeTypes: ['text/html;profile=mcp-app']}}}, clientInfo: {name: 'addon-check', version: '0.1.0'}}));
    if (!initialized.success || initialized.data.protocolVersion !== PROTOCOL) throw new CheckError('Initialization must negotiate 2025-11-25 with a valid MCP result');
    await transport.request('notifications/initialized', {}, token, true);
    add('transport.initialize', 'PASS', sources.transport, 'Streamable HTTP initialized on 2025-11-25; no GET stream required');
    if (!initialized.data.capabilities.tools) throw new CheckError('Server does not advertise tools capability');
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const names = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result = ListToolsResultSchema.safeParse(await transport.request('tools/list', cursor === undefined ? {} : {cursor}));
      if (!result.success) throw new CheckError('Malformed tools/list response');
      for (const tool of result.data.tools) {
        if (names.has(tool.name)) throw new CheckError('Duplicate tool name in discovery');
        names.add(tool.name); tools.push(tool);
      }
      cursor = result.data.nextCursor;
      if (cursor === undefined) break;
      if (cursors.has(cursor)) throw new CheckError('Tool pagination repeated a cursor');
      cursors.add(cursor);
      if (page === 99) throw new CheckError('Tool pagination exceeds 100 pages');
    }
    add('transport.discovery', 'PASS', sources.transport, 'Paginated tool discovery completed', {metrics: {tools: tools.length}});
  } catch (error) {
    if (error instanceof HttpError && error.challenge) {
      try { const uri = challenge(error.challenge).get('resource_metadata'); if (uri) prmUrls.add(endpoint(uri).href); } catch { /* Report transport failure below. */ }
    }
    add('transport.discovery', 'FAIL', sources.transport, safeError(error));
    missing.push('Complete authenticated discovery and execution unavailable');
    try { await authorization(url, prmUrls); add('auth.metadata', 'PASS', sources.auth, 'PRM resource identity and authorization metadata with S256 verified'); }
    catch (authError) { add('auth.metadata', 'FAIL', sources.auth, safeError(authError)); }
    return report(checks, missing, timed);
  }

  const inputs = new Map<string, ValidateFunction>();
  const outputs = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    const label = /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ? tool.name : '[invalid tool name]';
    add('tools.naming', label === tool.name ? 'PASS' : 'WARN', sources.tools, 'MCP naming guidance: 1–128 ASCII letters, digits, underscores, hyphens or dots', {tool: label});
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(tool.name)) add('tools.style', 'WARN', sources.policy, 'snake_case is recommended by this checker', {tool: label});
    add('tools.description', tool.description?.trim() ? 'PASS' : 'WARN', sources.tools, tool.description?.trim() ? 'Tool has a description' : 'Tool description is missing or empty', {tool: label});
    for (const [kind, schema, validators] of [['input', tool.inputSchema, inputs], ['output', tool.outputSchema, outputs]] as const) {
      if (schema === undefined) { add('schema.output', 'WARN', sources.tools, 'No output schema declared', {tool: label}); continue; }
      try { validators.set(tool.name, compile(schema)); add(`schema.${kind}`, 'PASS', sources.tools, 'Valid JSON Schema; formats treated as annotations', {tool: label}); }
      catch (error) { add(`schema.${kind}`, error instanceof UnsupportedSchema ? 'SKIP' : 'FAIL', sources.tools, safeError(error), {tool: label}); missing.push(`${label}: ${kind} schema not verified`); }
    }
    try {
      const ui = tool._meta?.ui;
      const legacy = tool._meta?.['ui/resourceUri'];
      if (ui !== undefined && (!object(ui) || (ui.visibility !== undefined && (!Array.isArray(ui.visibility) || !ui.visibility.length || !ui.visibility.every(v => v === 'app' || v === 'model'))))) throw new CheckError('Invalid MCP Apps tool metadata');
      if ((object(ui) && ui.resourceUri !== undefined && typeof ui.resourceUri !== 'string') || (legacy !== undefined && typeof legacy !== 'string')) throw new CheckError('UI resource reference must be a string');
      const uri = object(ui) ? ui.resourceUri ?? legacy : legacy;
      if (uri === undefined) { add('ui.resource', 'PASS', sources.apps, 'Not applicable: data-only tool', {tool: label}); continue; }
      if (typeof uri !== 'string' || !uri.startsWith('ui://')) throw new CheckError('UI reference must use ui://');
      if (legacy !== undefined) add('ui.legacy', 'WARN', sources.apps, 'Deprecated ui/resourceUri metadata; use ui.resourceUri', {tool: label});
      const resource = ReadResourceResultSchema.safeParse(await transport.request('resources/read', {uri}));
      if (!resource.success || !resource.data.contents.some(c => c.uri === uri) || resource.data.contents.some(c => c.uri !== uri || c.mimeType !== 'text/html;profile=mcp-app' || (c._meta?.ui !== undefined && !uiMetadata(c._meta.ui)) || ('blob' in c && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(c.blob)))) throw new CheckError('Broken UI resource reference, MIME type, content or metadata');
      add('ui.resource', 'PASS', sources.apps, 'UI reference resolves with documented resource metadata', {tool: label});
      add('ui.browser', 'MANUAL', sources.apps, 'Review HTML rendering, CSP/permissions and display modes in the browser ui/initialize exchange', {tool: label});
    } catch (error) { add('ui.resource', 'FAIL', sources.apps, safeError(error), {tool: label}); }
  }
  // Validate every supplied case before authorizing any tools/call.
  for (const test of cases) {
    if (!tools.some(t => t.name === test.tool)) throw new ConfigError('Cases file names a tool absent from discovery');
    const validate = inputs.get(test.tool);
    if (validate && !validate(test.arguments)) throw new ConfigError('Case arguments do not match the declared input schema; arguments withheld');
  }
  for (const [caseIndex, test] of cases.entries()) {
    const extra = {tool: /^[A-Za-z0-9_.-]{1,128}$/.test(test.tool) ? test.tool : '[invalid tool name]', caseIndex};
    const params = {name: test.tool, arguments: test.arguments};
    if (!inputs.has(test.tool)) { add('case.execution', 'SKIP', sources.policy, 'Input schema could not be validated; no tool call made', extra); continue; }
    if (test.authProbe) {
      let passed = true;
      for (const [kind, bearer] of [['missing', ''], ['malformed', 'addon-check.invalid-token']] as const) {
        try {
          await transport.request('tools/call', params, bearer);
          throw new CheckError('Protected call accepted an absent or malformed token');
        } catch (error) {
          try {
            if (!(error instanceof HttpError) || error.status !== 401) throw new CheckError('Protected call must return HTTP 401 for absent and malformed tokens');
            const fields = challenge(error.challenge);
            const uri = fields.get('resource_metadata');
            if (!uri || !fields.get('scope')?.trim() || (kind === 'malformed' && fields.get('error') !== 'invalid_token')) throw new CheckError('Challenge requires resource_metadata, nonempty scope and invalid_token for a malformed token');
            prmUrls.add(endpoint(uri).href);
            add(`auth.probe.${kind}`, 'PASS', sources.auth, 'Protected call returned scoped HTTP 401 challenge', extra);
          } catch (failure) { passed = false; add(`auth.probe.${kind}`, 'FAIL', sources.auth, safeError(failure), extra); }
        }
      }
      if (passed) authorizedProbes.add(caseIndex);
    }
    const samples: number[] = [];
    let warmup: number | undefined;
    let callsValid = true;
    let outputValid = true;
    let speechValid = test.speechPointers.length > 0;
    let formattingValid = true;
    let maxWords = 0;
    const rounds = test.repeatable ? 21 : 1;
    let completed = 0;
    for (let n = 0; n < rounds; n++) {
      let result: unknown;
      const start = performance.now();
      try { result = await transport.request('tools/call', params); }
      catch (error) { callsValid = false; add('case.execution', 'FAIL', sources.transport, safeError(error), extra); break; }
      const elapsed = performance.now() - start;
      if (test.repeatable) { if (n === 0) warmup = elapsed; else samples.push(elapsed); }
      completed++;
      const parsed = CallToolResultSchema.safeParse(result);
      if (!parsed.success || !object(result) || !Array.isArray(result.content) || !!parsed.data.isError !== test.expectError) { callsValid = false; break; }
      const validate = outputs.get(test.tool);
      // MCP error results need not satisfy the declared successful-output schema.
      if (!parsed.data.isError && validate && !validate(parsed.data.structuredContent)) outputValid = false;
      if (test.speechPointers.length) {
        try {
          const metrics = speechMetrics(speech(result, test.speechPointers));
          maxWords = Math.max(maxWords, metrics.words);
          if (metrics.words >= 75) speechValid = false;
          if (metrics.formatting) formattingValid = false;
        } catch { speechValid = false; formattingValid = false; }
      }
    }
    add('case.result', callsValid ? 'PASS' : 'FAIL', sources.tools, callsValid ? 'All executed calls returned valid MCP results with the expected error state' : 'Malformed MCP result, unexpected isError, or call failure', {...extra, metrics: {calls: completed, expectedError: test.expectError}});
    const declared = tools.find(t => t.name === test.tool)?.outputSchema !== undefined;
    const outputStatus = !callsValid ? 'SKIP' : test.expectError || !declared ? 'PASS' : !outputs.has(test.tool) ? 'SKIP' : outputValid ? 'PASS' : 'FAIL';
    add('case.output', outputStatus, sources.tools, test.expectError ? 'Not applicable: expected error; successful-output schema does not apply' : !declared ? 'MCP result validated; no declared structured-output schema' : outputStatus === 'PASS' ? 'Structured content satisfies declared output schema' : 'Structured output mismatch or validation unavailable', extra);
    if (!test.speechPointers.length) add('speech.estimate', 'SKIP', sources.policy, 'No speech pointers supplied; spoken evidence unavailable', extra);
    else {
      add('speech.estimate', speechValid && callsValid ? 'PASS' : 'FAIL', sources.policy, speechValid && callsValid ? 'English text estimate at 150 words/minute; not measured Alexa audio' : 'Speech pointer missing/wrong type, call unavailable, or speech reaches 75 words', {...extra, metrics: {maxWords, estimatedSeconds: maxWords / 2.5, wordsPerMinute: 150}});
      add('speech.formatting', formattingValid && callsValid ? 'PASS' : 'FAIL', sources.speech, formattingValid && callsValid ? 'Selected speech contains no checked formatting artifacts' : 'Selected speech contains formatting artifacts or could not be inspected', extra);
    }
    if (test.repeatable) {
      timed.push(extra.tool);
      add('latency.warmup', warmup === undefined ? 'SKIP' : 'PASS', sources.policy, 'One warm-up call excluded from the 20 measured calls', {...extra, metrics: {milliseconds: warmup ?? null}});
      add('latency.measured', callsValid && latencyPass(samples) ? 'PASS' : 'FAIL', sources.latency, 'Every one of 20 sequential round trips must be under 500 ms', {...extra, metrics: {samplesMs: samples, measuredCalls: samples.length, limitMs: 500}});
    }
    if (callsValid && !test.expectError) successfulCases.add(caseIndex);
    if (callsValid && outputStatus === 'PASS' && speechValid && formattingValid && !test.expectError) covered.add(test.tool);
  }
  try { await authorization(url, prmUrls); add('auth.metadata', 'PASS', sources.auth, 'PRM resource identity and authorization metadata with S256 verified'); }
  catch (error) { add('auth.metadata', 'FAIL', sources.auth, safeError(error)); }
  for (const tool of tools) if (!covered.has(tool.name)) {
    const label = /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ? tool.name : '[invalid tool name]';
    missing.push(`${label}: passing successful-output/speech case required`);
    add('evidence.tool', 'SKIP', sources.policy, 'No passing successful-output and selected-speech execution evidence', {tool: label});
  }
  if (!tools.length) missing.push('At least one tool with execution evidence required');
  if (![...authorizedProbes].some(index => successfulCases.has(index))) { missing.push('Passing protected auth probe and authorized successful call required'); add('evidence.auth', 'SKIP', sources.policy, 'Protected auth execution evidence unavailable'); }
  if (!checks.some(c => c.id === 'latency.measured' && c.status === 'PASS')) { missing.push('Passing repeatable latency case required'); add('evidence.latency', 'SKIP', sources.policy, 'No passing repeatable latency evidence'); }
  for (const check of checks) if (check.status === 'SKIP') missing.push(`${check.tool ?? 'server'}: ${check.id} skipped`);
  return report(checks, [...new Set(missing)], timed);
}
