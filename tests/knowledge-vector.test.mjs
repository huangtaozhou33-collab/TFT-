import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { indexKnowledge } from '../scripts/index-knowledge.mjs';
import { MilvusClient, embedTexts, embeddingEndpoint, embeddingReady, indexProfile, releaseFilter } from '../server/knowledge/vector.mjs';

const config = { backend: 'mysql', milvusUrl: 'http://milvus:19530',
  embedding: { baseUrl: 'https://embedding.example/v1/', key: 'embedding-fixture-key', model: 'fixture-model', dimensions: 3 } };
const configured = patch => ({ ...config, embedding: { ...config.embedding, ...patch } });
const release = { id: 'a'.repeat(64), currentPatch: '18.4', sourcePatch: '18.4' };
const chunks = count => Array.from({ length: count }, (_, i) => ({ id: `chunk-${i}`, title: `规则${i}`, text: `完整条件与规则${i}`, sourcePatch: '18.4', eligible: true }));
const response = data => ({ ok: true, json: async () => ({ data }) });
const embeddingRows = () => [{ index: 0, embedding: [1, 2, 3] }, { index: 1, embedding: [4, 5, 6] }];

test('importing the indexing command has no execution, logging or connection side effects', () => {
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/index-knowledge.mjs'); process.stdout.write('import-only')"],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, 'import-only');
  assert.equal(imported.stderr, '');
});

test('embedding uses an independent key and restores out-of-order provider indices', async () => {
  let requests = 0;
  const vectors = await embedTexts(['规则A', '规则B'], { config,
    fetchImpl: async (url, request) => {
      requests++;
      assert.equal(url, 'https://embedding.example/v1/embeddings');
      assert.equal(request.headers.Authorization, 'Bearer embedding-fixture-key');
      assert.equal(request.redirect, 'error');
      assert.deepEqual(JSON.parse(request.body).input, ['规则A', '规则B']);
      return response(embeddingRows().reverse());
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(vectors, [[1, 2, 3], [4, 5, 6]]);
});

test('missing independent embedding configuration cannot cause a database or provider request', async () => {
  let requests = 0;
  const missing = configured({ key: '' });
  assert.equal(embeddingReady(missing), false);
  await assert.rejects(embedTexts(['规则'], { config: missing, fetchImpl: async () => { requests++; } }), { code: 'EMBEDDING_NOT_CONFIGURED' });
  await assert.rejects(indexKnowledge({ config: missing }, { getPool: async () => { requests++; } }), { code: 'EMBEDDING_NOT_CONFIGURED' });
  assert.equal(requests, 0);
});

test('embedding endpoint requires HTTPS without credentials; loopback self-hosting alone may use HTTP', async () => {
  for (const baseUrl of ['http://localhost:9009/v1', 'http://127.0.0.1:9009/v1', 'http://[::1]:9009/v1', 'https://embedding.example/v1']) {
    assert.equal(embeddingReady(configured({ baseUrl })), true);
    assert.ok(embeddingEndpoint(configured({ baseUrl })).endsWith('/embeddings'));
  }
  let requests = 0;
  for (const baseUrl of ['http://embedding.example/v1', 'https://user:secret@embedding.example/v1', 'http://127.0.0.1.evil.example/v1',
    'file:///private/provider', 'https://embedding.example/v1?key=private', 'https://embedding.example/v1#private']) {
    const invalid = configured({ baseUrl });
    assert.equal(embeddingReady(invalid), false);
    await assert.rejects(embedTexts(['规则'], { config: invalid, fetchImpl: async () => { requests++; } }), { code: 'EMBEDDING_URL_INVALID' });
  }
  assert.equal(requests, 0);
});

test('embedding rejects wrong counts, dimensions, duplicate indices, null rows and non-finite or zero vectors', async () => {
  const badResponses = [[], [embeddingRows()[0]], [embeddingRows()[0], embeddingRows()[0]],
    [{ index: 1, embedding: [1, 2, 3] }, { index: 2, embedding: [4, 5, 6] }],
    [{ index: 0, embedding: [1, 2] }, embeddingRows()[1]],
    [{ index: 0, embedding: [1, Infinity, 3] }, embeddingRows()[1]],
    [{ index: 0, embedding: [0, 0, 0] }, embeddingRows()[1]],
    [null, embeddingRows()[1]]];
  for (const rows of badResponses) await assert.rejects(embedTexts(['A', 'B'], { config, fetchImpl: async () => response(rows) }), { code: 'EMBEDDING_RESPONSE_INVALID' });
});

test('embedding failures never expose provider bodies, parse errors or transport details', async () => {
  const privateMarker = 'PRIVATE_PROVIDER_BODY_AND_KEY';
  for (const fetchImpl of [
    async () => ({ ok: false, text: async () => { throw new Error('body must not be read'); }, json: async () => { throw new Error(privateMarker); } }),
    async () => ({ ok: true, json: async () => { throw new Error(privateMarker); } }),
    async () => { throw new Error(privateMarker); },
  ]) await assert.rejects(embedTexts(['A'], { config, fetchImpl }), error => !error.message.includes(privateMarker) && /^EMBEDDING_/.test(error.code));
});

test('Milvus search and complete verification use escaped release, patch and eligibility filters', async () => {
  const scope = { id: 'release" or eligible == false', currentPatch: '18.4\\"' }, calls = [];
  const client = new MilvusClient(config);
  client.call = async (path, body) => { calls.push({ path, body }); return []; };
  await client.search('fixture', [1, 2, 3], scope, 10);
  assert.equal(calls[0].body.filter, `release_id == ${JSON.stringify(scope.id)} and ((scope == "patch" and source_patch == ${JSON.stringify(scope.currentPatch)}) or (scope == "general" and source_patch == "")) and eligible == true`);
  assert.equal(calls[0].body.consistencyLevel, 'Strong');
  assert.throws(() => releaseFilter({ id: 'x' }), { code: 'INDEX_RELEASE_INVALID' });
  const ids = Array.from({ length: 260 }, (_, i) => `id-${i}`);
  client.call = async (path, body) => {
    calls.push({ path, body });
    assert.equal(path, 'entities/query');
    assert.ok(body.filter.startsWith(`${releaseFilter(release)} and id in `));
    assert.equal(body.consistencyLevel, 'Strong');
    const requested = JSON.parse(body.filter.slice(body.filter.indexOf(' and id in ') + 11));
    assert.equal(body.limit, requested.length);
    assert.deepEqual(body.outputFields, ['id', 'release_id', 'source_patch', 'scope', 'eligible']);
    return requested.reverse().map(id => ({ id, release_id: release.id, source_patch: release.currentPatch, scope: 'patch', eligible: true }));
  };
  assert.deepEqual(await client.verifyEntities('fixture', release, ids), { count: 260 });
  assert.equal(calls.filter(call => call.path === 'entities/query').length, 3);
});

test('complete Milvus verification rejects missing, duplicate, foreign-version and ineligible rows', async () => {
  const row = id => ({ id, release_id: release.id, source_patch: '18.4', scope: 'patch', eligible: true });
  for (const rows of [[row('a')], [row('a'), row('a')], [row('a'), row('other')],
    [row('a'), { ...row('b'), source_patch: '18.3' }], [row('a'), { ...row('b'), release_id: 'old-release' }],
    [row('a'), { ...row('b'), eligible: false }]]) {
    const client = new MilvusClient(config); client.call = async () => rows;
    await assert.rejects(client.verifyEntities('fixture', release, ['a', 'b']), { code: 'INDEX_VERIFY_FAILED' });
  }
});

function fixture({ rows = chunks(18), active = release, previous = null, lock = 1, receipt = null, verify = null } = {}) {
  const events = [], jobs = [];
  const connection = {
    query: async (sql, args) => { events.push({ type: 'sql', sql, args }); return [[{ acquired: lock }]]; },
    release: () => { events.push({ type: 'release-connection' }); },
  };
  const deps = {
    getPool: async () => ({ getConnection: async () => connection }),
    getActiveRelease: async db => { assert.equal(db, connection); events.push({ type: 'read-release' }); return active; },
    eligibleChunks: async (value, db) => { assert.equal(db, connection); events.push({ type: 'read-chunks' }); return rows; },
    getIndexJob: async (id, hash, db) => { assert.equal(db, connection); events.push({ type: 'read-job' }); return previous; },
    saveIndexJob: async (job, db) => { assert.equal(db, connection); jobs.push(job); events.push({ type: 'save-job', state: job.state }); },
    embedTexts: async texts => { events.push({ type: 'embed', count: texts.length }); return texts.map(() => [1, 2, 3]); },
    client: {
      ensureCollection: async () => { events.push({ type: 'ensure' }); },
      call: async (path, body) => { events.push({ type: path, body }); return path === 'entities/upsert' ? receipt ?? { upsertCount: body.data.length } : {}; },
      verifyEntities: async (collection, value, ids) => { events.push({ type: 'verify', ids }); return verify ? verify(ids) : { count: ids.length }; },
    },
  };
  return { deps, events, jobs };
}

test('index build serializes all writes under the advisory lock and publishes only after checking every expected ID', async () => {
  const f = fixture();
  const result = await indexKnowledge({ config }, f.deps);
  assert.equal(result.status, 'ready');
  assert.equal(result.chunks, 18);
  assert.equal(f.events[0].sql, 'SELECT GET_LOCK(?,0) AS acquired');
  assert.deepEqual(f.events.filter(event => event.type === 'embed').map(event => event.count), [16, 2]);
  assert.deepEqual(f.events.find(event => event.type === 'verify').ids, chunks(18).map(row => row.id));
  assert.ok(f.events.findIndex(event => event.type === 'verify') < f.events.findIndex(event => event.type === 'save-job' && event.state === 'ready'));
  assert.deepEqual(f.jobs.map(job => [job.state, job.count ?? 0]), [['running', 0], ['running', 16], ['running', 18], ['ready', 18]]);
  assert.equal(f.events.at(-2).sql, 'SELECT RELEASE_LOCK(?)');
  assert.equal(f.events.at(-1).type, 'release-connection');
});

test('indexing general terminology writes an explicit scope and empty patch without authorizing unscoped null patches', async () => {
  const glossary = { id: 'glossary-chunk', title: '慢D', text: '保留经济逐回合搜牌。', kind: 'glossary', sourcePatch: null, eligible: true,
    payload: { scope: 'general', editorialRevision: 'editorial-v1-1234567890abcdef' } };
  const f = fixture({ rows: [...chunks(1), glossary] });
  assert.equal((await indexKnowledge({ config }, f.deps)).chunks, 2);
  const rows = f.events.find(event => event.type === 'entities/upsert').body.data;
  assert.deepEqual(rows.map(({ id, scope, source_patch }) => ({ id, scope, source_patch })), [
    { id: 'chunk-0', scope: 'patch', source_patch: '18.4' }, { id: 'glossary-chunk', scope: 'general', source_patch: '' }]);
  const invalid = fixture({ rows: [{ ...glossary, kind: 'library' }] });
  await assert.rejects(indexKnowledge({ config }, invalid.deps), { code: 'INDEX_CHUNKS_INVALID' });
  assert.equal(invalid.events.some(event => event.type === 'embed'), false);
});

test('a competing index build cannot alter another job state or request embeddings', async () => {
  const f = fixture({ lock: 0 });
  await assert.rejects(indexKnowledge({ config }, f.deps), { code: 'INDEX_BUILD_BUSY' });
  assert.deepEqual(f.jobs, []);
  assert.equal(f.events.some(event => event.type === 'embed' || event.type === 'read-release'), false);
  assert.equal(f.events.some(event => event.sql === 'SELECT RELEASE_LOCK(?)'), false);
  assert.equal(f.events.at(-1).type, 'release-connection');
});

test('patch mismatch, empty eligible chunks and invalid chunks are checked before a prior ready job', async () => {
  for (const [options, code] of [
    [{ active: { ...release, currentPatch: '18.5' } }, 'INDEX_PATCH_MISMATCH'],
    [{ rows: [] }, 'INDEX_CHUNKS_EMPTY'],
    [{ rows: [{ ...chunks(1)[0], sourcePatch: '18.3' }] }, 'INDEX_CHUNKS_INVALID'],
    [{ rows: [{ ...chunks(1)[0], eligible: false }] }, 'INDEX_CHUNKS_INVALID'],
    [{ rows: [chunks(1)[0], chunks(1)[0]] }, 'INDEX_CHUNKS_INVALID'],
  ]) {
    const f = fixture({ ...options, previous: { state: 'ready', indexed_chunks: 18 } });
    await assert.rejects(indexKnowledge({ config }, f.deps), { code });
    assert.equal(f.events.some(event => event.type === 'read-job'), false);
    assert.deepEqual(f.jobs, []);
    assert.equal(f.events.at(-2).sql, 'SELECT RELEASE_LOCK(?)');
  }
});

test('short upsert receipts and incomplete final verification never become ready', async () => {
  for (const [options, code] of [[{ receipt: { upsertCount: 15 } }, 'INDEX_UPSERT_INCOMPLETE'],
    [{ receipt: {} }, 'INDEX_UPSERT_INCOMPLETE'], [{ verify: () => ({ count: 1 }) }, 'INDEX_VERIFY_FAILED']]) {
    const f = fixture(options);
    await assert.rejects(indexKnowledge({ config }, f.deps), { code });
    assert.equal(f.jobs.some(job => job.state === 'ready'), false);
    assert.equal(f.jobs.at(-1).state, 'failed');
    assert.equal(f.jobs.at(-1).errorCode, code);
    assert.equal(f.events.at(-2).sql, 'SELECT RELEASE_LOCK(?)');
  }
});

test('a prior ready job is fully verified without embedding again and cannot hide a missing chunk', async () => {
  const profile = indexProfile(config), collection = `tft_${profile.hash.slice(0, 16)}_${release.id.slice(0, 16)}`;
  const previous = { state: 'ready', indexed_chunks: 18, collection_name: collection };
  const good = fixture({ previous });
  assert.equal((await indexKnowledge({ config }, good.deps)).status, 'unchanged');
  assert.equal(good.events.some(event => event.type === 'embed' || event.type === 'entities/upsert'), false);
  assert.equal(good.events.find(event => event.type === 'verify').ids.length, 18);
  const bad = fixture({ previous, verify: () => ({ count: 17 }) });
  await assert.rejects(indexKnowledge({ config }, bad.deps), { code: 'INDEX_VERIFY_FAILED' });
  assert.equal(bad.jobs.at(-1).state, 'failed');
  assert.equal(bad.jobs.some(job => job.state === 'ready'), false);
});

test('active release changes during indexing prevent readiness', async () => {
  const f = fixture(); let reads = 0;
  f.deps.getActiveRelease = async () => ++reads === 1 ? release : { ...release, currentPatch: '18.5' };
  await assert.rejects(indexKnowledge({ config }, f.deps), { code: 'INDEX_RELEASE_CHANGED' });
  assert.equal(f.jobs.at(-1).state, 'failed');
  assert.equal(f.jobs.some(job => job.state === 'ready'), false);
});
