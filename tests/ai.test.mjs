import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRequest, AIError } from '../server/ai.mjs';

const config = { key: 'test-key-must-not-leak', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
test('missing keys fail locally without a provider call', async () => {
  await assert.rejects(providerRequest('/models', undefined, { config: { ...config, key: '' } }), e => e instanceof AIError && e.code === 'AI_KEY_MISSING');
});
test('insecure or embedded-credential URLs cannot receive an API key', async () => {
  for (const baseUrl of ['http://example.com', 'https://user:password@example.com', 'not a URL']) {
    await assert.rejects(providerRequest('/models', undefined, { config: { ...config, baseUrl } }), e => e.code === 'INVALID_AI_URL');
  }
});
test('HTTP errors expose safe status but never echo a provider body', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ secret: config.key }), { status: 401 });
  try {
    await assert.rejects(providerRequest('/models', undefined, { config }), e => e.code === 'AI_HTTP_401' && !e.message.includes(config.key));
  } finally { globalThis.fetch = original; }
});
test('network layer distinguishes DNS errors from upstream HTTP failures', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  try { await assert.rejects(providerRequest('/models', undefined, { config }), e => e.code === 'AI_NETWORK_ERROR' && e.message.includes('DNS')); }
  finally { globalThis.fetch = original; }
});
test('success parses JSON and sends server-side authorization', async () => {
  const original = globalThis.fetch;
  let called;
  globalThis.fetch = async (url, options) => { called = { url, options }; return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })); };
  try {
    const data = await providerRequest('/models', undefined, { config });
    assert.equal(data.data[0].id, 'deepseek-flash');
    assert.equal(called.url.href, 'https://api.deepseek.com/models');
    assert.equal(called.options.headers.Authorization, `Bearer ${config.key}`);
  } finally { globalThis.fetch = original; }
});
