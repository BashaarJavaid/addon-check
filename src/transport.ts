import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

export const PROTOCOL = '2025-11-25';
export const DEADLINE = 10_000;
export const MAX_BYTES = 1024 * 1024;

export class CheckError extends Error {}
export class HttpError extends CheckError {
  constructor(public status: number, public challenge: string | null) {
    super(`HTTP ${status}; response payload withheld`);
  }
}

export function endpoint(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new CheckError('Use HTTPS (or loopback HTTP), without credentials or fragment');
  }
  return url;
}

// Native fetch avoids SDK reconnects, auth retries and the optional GET stream.
// SDK schemas below still validate the complete protocol envelopes and results.
export class Transport {
  private id = 0;
  private session: string | undefined;
  constructor(readonly url: URL, private token?: string) {}

  async request(method: string, params: Record<string, unknown> = {}, token = this.token, notification = false): Promise<unknown> {
    const id = ++this.id;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const response = await exchange(this.url, {
      method: 'POST', headers,
      body: JSON.stringify({jsonrpc: '2.0', ...(notification ? {} : {id}), method, params}),
    }, notification ? undefined : id);
    const session = response.headers.get('Mcp-Session-Id');
    if (session !== null) {
      if (!/^[\x21-\x7e]+$/.test(session)) throw new CheckError('Invalid MCP session identifier');
      this.session = session;
    }
    if (notification) {
      if (response.status !== 202 || response.value !== undefined) throw new CheckError('Notification requires HTTP 202 with an empty body');
      return;
    }
    const message = JSONRPCMessageSchema.safeParse(response.value);
    if (!message.success || !('id' in message.data) || message.data.id !== id || 'method' in message.data) {
      throw new CheckError('Malformed or uncorrelated JSON-RPC response');
    }
    if ('error' in message.data) throw new CheckError(`JSON-RPC error ${message.data.error.code}; details withheld`);
    return message.data.result;
  }
}

export async function metadata(url: URL): Promise<unknown> {
  return (await exchange(url, {method: 'GET', headers: {Accept: 'application/json'}})).value;
}

async function exchange(url: URL, init: RequestInit, id?: number): Promise<{status: number; headers: Headers; value: unknown}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {...init, redirect: 'manual', signal: controller.signal});
    if (!response.ok) throw new HttpError(response.status, response.headers.get('WWW-Authenticate'));
    const length = Number(response.headers.get('Content-Length'));
    if (length > MAX_BYTES) throw new CheckError('Response exceeds 1 MiB');
    const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    const sse = type === 'text/event-stream' && id !== undefined;
    if (response.status !== 202 && type !== 'application/json' && !sse) throw new CheckError('Expected JSON or a POST SSE response');
    reader = response.body?.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let bytes = 0;
    let text = '';
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new CheckError('Response exceeds 1 MiB');
      text += decoder.decode(chunk.value, {stream: true});
      if (sse) {
        // Event boundaries may straddle chunks; do not normalize a trailing CR.
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(text))) {
          const event = text.slice(0, boundary.index);
          text = text.slice(boundary.index + boundary[0].length);
          const lines = event.split(/\r\n|\r|\n/);
          const kind = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
          if (kind && kind !== 'message') continue;
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          const parsed = JSONRPCMessageSchema.safeParse(JSON.parse(data));
          if (!parsed.success) throw new CheckError('Malformed SSE JSON-RPC message');
          if ('method' in parsed.data) {
            if ('id' in parsed.data) throw new CheckError('Server requested an unsupported client operation');
            continue;
          }
          if (parsed.data.id !== id) throw new CheckError('Uncorrelated SSE response');
          return {status: response.status, headers: response.headers, value: parsed.data};
        }
      }
    }
    text += decoder.decode();
    if (sse) throw new CheckError('SSE ended without a correlated response');
    return {status: response.status, headers: response.headers, value: text ? JSON.parse(text) : undefined};
  } catch (error) {
    if (error instanceof CheckError) throw error;
    throw new CheckError(controller.signal.aborted ? 'Response deadline exceeded (10 seconds)' : 'Network failure or malformed JSON/UTF-8; details withheld');
  } finally {
    clearTimeout(timer);
    if (reader) await reader.cancel().catch(() => {});
    controller.abort();
  }
}
