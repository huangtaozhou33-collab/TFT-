import { setDefaultResultOrder } from 'node:dns';

// This machine's default IPv6-first route timed out. Keep certificate validation on.
setDefaultResultOrder('ipv4first');

export class SourceError extends Error {
  constructor(message, layer, details = {}) { super(message); this.name = 'SourceError'; this.layer = layer; Object.assign(this, details); }
}

export function describeError(error) {
  if (error instanceof SourceError) return { layer: error.layer, message: error.message, code: error.code ?? null, httpStatus: error.httpStatus ?? null };
  const code = error.cause?.code ?? error.code;
  const message = error.cause?.message ?? error.message;
  const layer = ['ENOTFOUND', 'EAI_AGAIN'].includes(code) ? 'dns' : /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code ?? '') ? 'tls' : /TIMEOUT|ABORT|ECONN|ENET|EHOST/.test(code ?? '') || error.name === 'TimeoutError' ? 'connection' : 'unknown';
  return { layer, message, code: code ?? null, httpStatus: null };
}

async function readRPC(response, id) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    const text = (await response.text()).slice(0, 1200);
    const retry=response.headers.get('retry-after'),seconds=Number(retry);
    const retryAfterMs=retry?(Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(retry)-Date.now())):0;
    throw new SourceError(`HTTP ${response.status}: ${text}`, 'http', { httpStatus: response.status, retryAfterMs:Number.isFinite(retryAfterMs)?retryAfterMs:0 });
  }
  if (response.status === 202 || response.status === 204) return null;
  if (!contentType.includes('text/event-stream')) {
    let body;
    try { body = await response.json(); } catch { throw new SourceError('Response was not valid JSON or SSE.', 'mcp'); }
    const rpc = Array.isArray(body) ? body.find(message => message.id === id) : body;
    if (!rpc || rpc.id !== id || rpc.jsonrpc !== '2.0') throw new SourceError('Response JSON-RPC id or version does not match.', 'mcp');
    if (rpc.error) throw new SourceError(rpc.error.message ?? 'MCP RPC error', 'mcp', { code: rpc.error.code });
    return rpc.result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new SourceError('SSE closed before the matching JSON-RPC response.', 'mcp');
      received += value.byteLength;
      if (received > 30_000_000) throw new SourceError('MCP payload exceeded local size limit.', 'mcp');
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let body;
        try { body = JSON.parse(data); } catch { throw new SourceError('SSE event data was not valid JSON.', 'mcp'); }
        const rpc = Array.isArray(body) ? body.find(message => message.id === id) : body;
        if (rpc?.id !== id) continue;
        if (rpc.jsonrpc !== '2.0') throw new SourceError('SSE response JSON-RPC version does not match.', 'mcp');
        if (rpc.error) throw new SourceError(rpc.error.message ?? 'MCP RPC error', 'mcp', { code: rpc.error.code });
        return rpc.result;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export class OPGGClient {
  constructor(endpoint = 'https://mcp-api.op.gg/mcp') { this.endpoint = endpoint; this.session = null; this.protocol = '2025-03-26'; this.id = 0; this.tools = []; this.initializing = null; }
  async request(method, params, notification = false) {
    const id = notification ? undefined : ++this.id;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = this.protocol;
    const response = await fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(35_000) });
    if (response.headers.get('Mcp-Session-Id')) this.session = response.headers.get('Mcp-Session-Id');
    return readRPC(response, id);
  }
  async initialize() {
    if (this.tools.length) return this.tools;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const result = await this.request('initialize', { protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: 'tft-assistant-local-research', version: '1.0.0' } });
      if (!result?.protocolVersion) throw new SourceError('Initialize result has no protocolVersion.', 'schema');
      this.protocol = result.protocolVersion; this.serverInfo = result.serverInfo;
      await this.request('notifications/initialized', null, true);
      let cursor; const tools = [];
      for (let page = 0; page < 20; page++) {
        const result = await this.request('tools/list', cursor ? { cursor } : {});
        if (!Array.isArray(result?.tools)) throw new SourceError('tools/list response has no tools array.', 'schema');
        tools.push(...result.tools); cursor = result.nextCursor;
        if (!cursor) break;
      }
      this.tools = tools; return tools;
    })();
    try { return await this.initializing; } finally { this.initializing = null; }
  }
  async call(name, args) {
    await this.initialize();
    const tool = this.tools.find(tool => tool.name === name);
    if (!tool) throw new SourceError(`Unknown upstream tool ${name}.`, 'schema');
    const missing = (tool.inputSchema?.required ?? []).filter(key => args[key] === undefined);
    if (missing.length) throw new SourceError(`Missing required tool arguments: ${missing.join(', ')}`, 'schema');
    const properties = tool.inputSchema?.properties ?? {};
    for (const [key, value] of Object.entries(args)) {
      if (!properties[key]) throw new SourceError(`Unsupported upstream argument ${key}.`, 'schema');
      if (properties[key].enum && !properties[key].enum.includes(value)) throw new SourceError(`Value for ${key} is outside the current upstream enum.`, 'schema');
      if (properties[key].type === 'string' && typeof value !== 'string') throw new SourceError(`${key} must be a string.`, 'schema');
    }
    let result;
    try { result = await this.request('tools/call', { name, arguments: args }); }
    catch (error) {
      if (error.layer !== 'http' || error.httpStatus !== 404 || !this.session) throw error;
      this.session = null; this.tools = []; await this.initialize();
      result = await this.request('tools/call', { name, arguments: args });
    }
    if (result?.isError) throw new SourceError(result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? 'Upstream tool returned isError.', 'tool');
    return result;
  }
  async close() {
    if (!this.session) return;
    try { await fetch(this.endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.session, 'MCP-Protocol-Version': this.protocol }, signal: AbortSignal.timeout(10_000) }); } finally { this.session = null; this.tools = []; }
  }
}

export function unwrapTool(result) {
  if (result.structuredContent) return result.structuredContent;
  const texts = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text);
  if (texts.length === 1) { try { return JSON.parse(texts[0]); } catch {} }
  return { text: texts.join('\n') };
}
