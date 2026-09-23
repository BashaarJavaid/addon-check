// Synthetic fixture only: no real household, OAuth login, devices or side effects.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

export const fixtureCase = (tool = 'read_context', extra = {}) => ({
  tool, arguments: {}, speechPointers: ['/structuredContent/speech'],
  repeatable: tool === 'read_context', expectError: false, authProbe: tool === 'read_context', ...extra,
});
export async function fixture(options = {}) {
  const state = {calls: [], requests: [], initialized: 0};
  let origin;
  const inputSchema = options.inputSchema ?? {type: 'object', additionalProperties: false};
  const outputSchema = options.outputSchema ?? {type: 'object', required: ['speech'], properties: {speech: {type: 'string'}}, additionalProperties: false};
  const tools = ['read_context', 'write_once'].map(name => ({name, description: 'Synthetic test operation.', inputSchema, outputSchema}));
  if (options.noDescription) delete tools[0].description;
  if (options.noOutput) delete tools[0].outputSchema;
  if (options.name) tools[0].name = options.name;
  if (options.ui) tools[0]._meta = {ui: options.ui === 'bad-meta' ? {visibility: ['everyone']} : {resourceUri: 'ui://fixture/card'}};
  const server = createServer(async (req, res) => {
    state.requests.push({path: req.url, method: req.method, authorization: req.headers.authorization, protocol: req.headers['mcp-protocol-version']});
    const json = (status, value, headers = {}) => {res.writeHead(status, {'Content-Type': 'application/json', ...headers}); res.end(JSON.stringify(value));};
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) {
      if (options.pathFallback && req.url.endsWith('/mcp')) return json(404, {});
      return json(200, {resource: options.badResource ? `${origin}/elsewhere` : `${origin}/mcp`, authorization_servers: [origin]});
    }
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) {
      return json(200, {issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ['code'], code_challenge_methods_supported: options.noS256 ? ['plain'] : ['S256']});
    }
    if (req.url !== '/mcp') return json(404, {});
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    const reply = result => {
      const envelope = {jsonrpc: '2.0', id: options.wrongId ? -1 : message.id, result};
      if (options.sse) {
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        res.write(': heartbeat\r\n\r\n');
        res.write(`event: message\r\ndata: ${JSON.stringify({jsonrpc: '2.0', method: 'notifications/message', params: {level: 'info', data: 'synthetic'}})}\r\n\r\n`);
        const event = `event: message\r\ndata: ${JSON.stringify(envelope)}\r\n\r\n`;
        // Split UTF-8 and CRLF boundaries; leave stream open to test cancellation.
        res.write(event.slice(0, -3));
        setTimeout(() => res.write(event.slice(-3)), 1);
      } else json(200, envelope);
    };
    if (options.redirect) {res.writeHead(307, {Location: `${origin}/leak`}); return res.end();}
    if (options.hang) return;
    if (options.hangBody) {res.writeHead(200, {'Content-Type': 'application/json'}); res.write('{'); return;}
    if (options.largeHeader) {res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': 1024 * 1024 + 1}); return res.end();}
    if (options.oversized) {res.writeHead(200, {'Content-Type': 'application/json'}); return res.end(' '.repeat(1024 * 1024 + 1));}
    if (options.badJson) {res.writeHead(200, {'Content-Type': 'application/json'}); return res.end('{private-payload');}
    if (message.method === 'initialize') {state.initialized++; return reply({protocolVersion: options.protocol ?? '2025-11-25', capabilities: {tools: {}, resources: {}}, serverInfo: {name: 'synthetic', version: '1'}});}
    if (message.method === 'notifications/initialized') {res.writeHead(202); return res.end();}
    if (message.method === 'tools/list') {
      if (options.pagination === 'repeat') return reply({tools: [], nextCursor: 'same'});
      if (options.pagination === 'endless') return reply({tools: [], nextCursor: String(Number(message.params.cursor ?? 0) + 1)});
      if (options.pagination === 'valid') return reply(message.params.cursor ? {tools: [tools[1]]} : {tools: [tools[0]], nextCursor: 'page2'});
      return reply({tools});
    }
    if (message.method === 'resources/read') {
      const uri = options.ui === 'broken' ? 'ui://fixture/wrong' : 'ui://fixture/card';
      return reply({contents: [{uri, mimeType: 'text/html;profile=mcp-app', text: '<!DOCTYPE html><html><title>Synthetic</title></html>', _meta: {ui: options.ui === 'bad-resource-meta' ? {prefersBorder: 'yes'} : {prefersBorder: true}}}]});
    }
    if (message.method === 'tools/call') {
      state.calls.push({name: message.params.name, authorization: req.headers.authorization, arguments: message.params.arguments});
      if (!options.public && req.headers.authorization !== 'Bearer synthetic-token') {
        const challenge = options.badChallenge ? 'Bearer scope="read"' : `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="read", error="invalid_token"`;
        return json(options.bad401 ? 403 : 401, {private: 'secret payload'}, {'WWW-Authenticate': challenge});
      }
      const authorized = state.calls.filter(c => c.authorization === 'Bearer synthetic-token').length;
      if (options.slowWarmup && authorized === 1) await new Promise(resolve => setTimeout(resolve, 550));
      if (options.slow && authorized === 2) await new Promise(resolve => setTimeout(resolve, 510));
      const speech = options.words ? Array(options.words).fill('word').join(' ') : options.speech ?? 'A synthetic response, with ordinary punctuation: $5.00 (estimated).';
      if (options.missingContent) return reply({structuredContent: {speech}});
      if (options.malformed) return reply({content: [{type: 'text', text: 42}]});
      return reply({content: [{type: 'text', text: 'Synthetic result'}], structuredContent: {speech: options.outputMismatch ? 42 : speech}, ...(options.error ? {isError: true} : {})});
    }
    json(400, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {url: `${origin}/mcp`, state, close: async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await fixture(process.argv.includes('--broken') ? {words: 75} : {});
  console.log(`Synthetic fixture: ${server.url}`);
  console.log('Use token environment value synthetic-token and examples/cases.json; no real authorization is represented.');
}
