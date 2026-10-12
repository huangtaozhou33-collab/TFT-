import test from 'node:test';
import assert from 'node:assert/strict';
import { answerChat, debugChatRetrieval, serializeToolResult } from '../server/chat.mjs';
import { beginDeveloperTrace, recordDeveloperTool, setDeveloperTraceContext, finishDeveloperTrace,
  listDeveloperTraces, getDeveloperTrace, developerTraceRetention, developerRetrievalPreview } from '../server/developer-traces.mjs';
import { cacheKeyFor } from '../scripts/stats-cache.mjs';

test('trace uses configured tool budget and query-tool metric names',()=>{
  const id=beginDeveloperTrace({question:'按前四率排序',toolLimit:12});
  const output={status:'ok',selection:{sort:'top4Rate',minSample:1000},data:[]};
  recordDeveloperTool(id,{name:'query_tft_stats',args:{view:'holders'},output,serialized:JSON.stringify(output),startedAt:new Date().toISOString(),completedAt:new Date().toISOString()});
  const trace=getDeveloperTrace(id);
  assert.equal(trace.budget.limit,12);assert.equal(trace.budget.remaining,11);
  assert.equal(trace.tools[0].ranking.metric,'top4Rate');assert.equal(trace.tools[0].ranking.direction,'desc');assert.equal(trace.tools[0].ranking.minimumSampleSize,1000);
});

const catalog = {
  context: { game: 'tft', set: 18, assetVersion: '16.20', rulesVersion: 'fixture-v1', mutator: 'TFTSet18', gamePatch: null,
    fetchedAt: '2026-10-07T10:00:00.000Z' },
  champions: [{ id: 'maokai', name: '茂凯', aliases: ['大树'], traits: ['主宰'], cost: 5, role: 'tank' }],
  items: ['stoneplate', 'warmog', 'spirit'].map((id, position) => ({ id,
    name: ['石像鬼石板甲', '狂徒铠甲', '振奋盔甲'][position], kind: 'completed', slotCost: 1, components: [], unique: false })),
  traits: [{ id: 'juggernaut', name: '主宰', effects: [{ minUnits: 2 }] }], augments: [], sources: [],
};
const evidence = { source: 'OP.GG MCP', endpoint: 'https://mcp-api.op.gg/mcp', delivery: 'version_cache',
  cacheKey: cacheKeyFor(catalog), set: 18, assetVersion: '16.20', rulesVersion: 'fixture-v1', sourcePatch: null,
  sourceTime: '2026-10-07T12:59:23.000Z', fetchedAt: '2026-10-07T13:36:26.808Z', population: null };
const source = data => ({ status: 'live', delivery: 'version_cache', cacheKey: evidence.cacheKey,
  data: structuredClone(data), evidence: structuredClone(evidence) });
const decks = source([
  { id: 'tiny', name: '微小样本', units: [{ id: 'maokai', isCore: true, items: ['stoneplate', 'warmog', 'spirit'] }], stats: { sampleSize: 2, avgPlacement: 1 } },
  { id: 'ranked', name: '主宰 茂凯', units: [{ id: 'maokai', isCore: true, items: ['stoneplate', 'warmog', 'spirit'] }], stats: { sampleSize: 400, avgPlacement: 3.2 } },
]);
const builds = source([
  { championId: 'maokai', itemIds: ['stoneplate', 'warmog', 'spirit'], stats: { sampleSize: 250, avgPlacement: 3.4 } },
  { championId: 'maokai', itemIds: ['warmog', 'stoneplate', 'spirit'], stats: { sampleSize: 180, avgPlacement: 4.3 } },
  { championId: 'maokai', itemIds: ['spirit', 'warmog', 'stoneplate'], stats: { sampleSize: 2, avgPlacement: 1 } },
]);
const dependencies = overrides => ({
  getCatalog: async () => structuredClone(catalog), getMetaDecks: async () => structuredClone(decks),
  getChampionBuild: async () => structuredClone(builds), getItemHolders: async () => source([]),
  getTraitStats: async () => ({ status: 'not_cached', data: [], evidence: null }),
  getSeasonMechanic: async () => ({ status: 'not_cached', entries: [], rating: { status: 'unrated' } }),
  getExplorerSnapshot: async () => ({ status: 'not_cached', rows: [], evidence: null }),
  chatCompletion: async () => { assert.fail('retrieval must not call a model'); }, ...overrides,
});
const body = question => ({ messages: [{ role: 'user', content: question }], pageContext: { readonly: true, view: 'library' } });
function payloads(messages) {
  return messages.filter((message, index) => index > 0 && message.role === 'system').map(message => JSON.parse(message.content.split('\n')[1]));
}

test('zero-model preview shares the actual prefetch payloads, version binding and source ranking with answerChat', async () => {
  const request = body('大树最佳阵容和三件装备');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('offline retrieval must never fetch');
  try {
    const preview = await debugChatRetrieval(request, dependencies());
    assert.equal(preview.mode, 'prefetch_preview');
    assert.deepEqual(preview.tools.map(tool => tool.name), ['get_meta_decks', 'get_champion_build']);
    assert.equal(preview.versionFilters.catalog.cacheKey, evidence.cacheKey);
    assert.equal(preview.versionFilters.draft.placeholderUsed, true);
    assert.equal(preview.versionFilters.draft.excluded, true);
    assert.equal(preview.budget.executed, 2);
    assert.equal(preview.budget.remaining, 2);
    assert.equal(preview.tools[0].result.data[0].id, 'ranked', 'tiny samples do not win metric ranking');
    assert.equal(preview.ranking[0].metric, 'avgPlacement');
    assert.equal(preview.ranking[0].minimumSampleSize, 100);
    assert.equal(preview.ranking[0].similarityScore, null);
    assert.equal(preview.ranking[0].confidenceScore, null);
    assert.equal(preview.reranking.score, null);
    assert.equal(preview.cache.redis.hit, null);
    assert.equal(preview.cache.redis.status, 'not_connected');
    assert.equal(preview.cache.reads[0].delivery, 'version_cache');
    assert.equal(preview.cache.reads[0].fetchedAt, evidence.fetchedAt);
    assert.equal(preview.cache.reads[0].sourceTime, evidence.sourceTime);
    assert.equal(preview.cache.reads[0].sourcePatch, null);
    assert.deepEqual(getDeveloperTrace(preview.traceId).modelInputs, []);

    let submitted;
    const answer = await answerChat(request, dependencies({ chatCompletion: async messages => {
      submitted = structuredClone(messages);
      return { message: { content: '采用主宰 茂凯。[S2]' }, usage: null };
    } }));
    assert.deepEqual(preview.modelContext.map(segment => JSON.parse(segment.content)), payloads(submitted));
    const trace = getDeveloperTrace(answer.traceId);
    assert.equal(trace.id, answer.traceId);
    assert.equal(trace.status, 'completed');
    assert.deepEqual(trace.modelInputs[0].segmentIds, trace.modelContext.map(segment => segment.id));
    assert.equal(trace.citations.retrieved.length, 3);
    assert.deepEqual(trace.citations.cited.map(entry => entry.id), ['S2']);
    assert.deepEqual(trace.citations.unresolvedIds, []);
    const buildRows = trace.statRows.filter(row => row.championId === 'maokai');
    assert.equal(new Set(buildRows.map(row => row.traceRowId)).size, buildRows.length);
    assert.ok(buildRows.every(row => row.sourceRowId === null), 'synthetic build identifiers never pretend to be source row IDs');
  } finally { globalThis.fetch = originalFetch; }
});

test('version mismatch fails before reading statistics, while sourcePatch stays an independent requested attribute', async () => {
  let statisticsReads = 0;
  const sources = dependencies({ getMetaDecks: async () => { statisticsReads++; return decks; },
    getSeasonMechanic: async () => { statisticsReads++; return { entries: [] }; } });
  let traceId;
  await assert.rejects(debugChatRetrieval({ question: '大树最佳阵容', context: { set: 999 } }, sources), error => {
    traceId = error.traceId; return error.code === 'DEBUG_VERSION_MISMATCH' && error.status === 400;
  });
  assert.equal(statisticsReads, 0);
  const failed = getDeveloperTrace(traceId);
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.tools, []); assert.deepEqual(failed.modelInputs, []);
  assert.deepEqual(failed.citations.retrieved, []);
  const preview = await debugChatRetrieval({ question: '大树最佳阵容', context: { set: 18, cacheKey: evidence.cacheKey,
    assetVersion: '16.20', rulesVersion: 'fixture-v1', sourcePatch: '18.4' } }, dependencies());
  assert.equal(preview.versionFilters.requested.sourcePatch, '18.4');
  assert.equal(preview.versionFilters.sourcePatchFilterApplied, false);
  assert.equal(preview.cache.reads[0].sourcePatch, null, 'an unrelated requested patch cannot replace OP.GG unknown patch');
});

test('knowledge previews report actual hybrid or fallback status and count evidence separately from tool envelopes', () => {
  for (const retrieval of [
    { mode: 'hybrid', vectorStatus: 'ready', cacheHit: true, candidates: 2 },
    { mode: 'lexical', vectorStatus: 'unavailable', cacheHit: false, candidates: 2 },
  ]) {
    const id = beginDeveloperTrace({ mode: 'prefetch_preview', question: '速八是什么意思？' });
    const output = { status: 'ready', retrieval, evidence: [
      { documentId: 'glossary:fast-eight', title: '速八（升八级）' },
      { documentId: 'glossary:fast-eighth', title: '速八（第八出局）' },
    ] };
    recordDeveloperTool(id, { name: 'search_knowledge', phase: 'prefetch', args: {}, output,
      serialized: serializeToolResult(output), startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    const preview = developerRetrievalPreview(id);
    assert.equal(preview.ranking[0].method, `knowledge_${retrieval.mode}`);
    assert.deepEqual(preview.ranking[0].retrieval, retrieval);
    assert.equal(preview.ranking[0].similarityScore, null, 'Do not invent a similarity score from readiness.');
    assert.equal(preview.ranking[0].confidenceScore, null);
    assert.equal(preview.recall.fragments.length, 1);
    assert.equal(preview.recall.knowledgeEvidenceCount, 2);
    assert.deepEqual(preview.recall.knowledgeRetrievals, [{ toolIndex: 1, ...retrieval }]);
    assert.equal(preview.reranking.status, 'not_connected', 'Vector search does not imply a reranker.');
    assert.doesNotMatch(preview.recall.note, /没有向量召回/);
    assert.doesNotMatch(preview.reranking.note, /未接入向量模型/);
  }
});

test('completion failures retain the actual retrieved contexts and omit secrets, history and raw provider errors', async () => {
  const secret = 'sk-private0123456789';
  const request = body(`大树最佳阵容 API_KEY=${secret}`);
  request.messages.unshift({ role: 'user', content: 'OLD_HISTORY_MARKER' }, { role: 'assistant', content: 'OLDER_REPLY_MARKER' });
  let traceId;
  await assert.rejects(answerChat(request, dependencies({ chatCompletion: async () => {
    throw Object.assign(new Error(`RAW_PROVIDER_BODY Authorization: Bearer ${secret}`), { code: 'AI_HTTP_401' });
  } })), error => { traceId = error.traceId; return error.code === 'AI_HTTP_401'; });
  const trace = getDeveloperTrace(traceId), encoded = JSON.stringify(trace);
  assert.equal(trace.status, 'failed'); assert.equal(trace.failure.stage, 'completion');
  assert.equal(trace.failure.code, 'AI_HTTP_401'); assert.equal(trace.modelInputs.length, 1);
  assert.ok(trace.citations.retrieved.length > 0); assert.deepEqual(trace.citations.cited, []);
  for (const forbidden of [secret, 'RAW_PROVIDER_BODY', 'OLD_HISTORY_MARKER', 'OLDER_REPLY_MARKER', 'systemPrompt', 'authorization', 'AI_API_KEY', '你是「TFT助手」']) {
    assert.equal(encoded.includes(forbidden), false, `trace must omit ${forbidden}`);
  }
  assert.ok(trace.question.includes('[REDACTED]'));
  const preview = await debugChatRetrieval({ question: 'x'.repeat(5000) }, dependencies());
  assert.equal(preview.question.length, 4000);
});

test('model-selected tools are traced with sanitized arguments, submission references and final citation resolution', async () => {
  let turn = 0, submittedTool;
  const answer = await answerChat(body('查看目录'), dependencies({ chatCompletion: async messages => {
    if (++turn === 1) return { message: { content: null, tool_calls: [{ id: 'mock-search', type: 'function',
      function: { name: 'search_catalog', arguments: JSON.stringify({ query: '大树', kind: 'champions', authorization: 'sensitive-extra' }) } }] } };
    submittedTool = messages.find(message => message.role === 'tool').content;
    return { message: { content: '这是茂凯。[S1] 错误引用[S999]' } };
  } }));
  const trace = getDeveloperTrace(answer.traceId);
  assert.equal(trace.tools.length, 1); assert.equal(trace.tools[0].phase, 'model');
  assert.deepEqual(trace.tools[0].args, { query: '大树', kind: 'champions' });
  assert.equal(JSON.stringify(trace).includes('sensitive-extra'), false);
  assert.equal(trace.modelInputs.length, 2);
  const segment = trace.modelContext.find(entry => entry.toolName === 'search_catalog');
  assert.deepEqual(JSON.parse(segment.content), JSON.parse(submittedTool));
  assert.deepEqual(segment.submittedIn, [2]);
  assert.deepEqual(trace.citations.cited.map(entry => entry.id), ['S1']);
  assert.deepEqual(trace.citations.unresolvedIds, ['S999']);
  assert.equal(listDeveloperTraces({ limit: 1 }).traces[0].id, answer.traceId);
});

test('traces describe serialized omissions instead of recording source rows that never reach the model', async () => {
  const bulky = structuredClone(decks);
  bulky.evidence.snippets = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, 'x'.repeat(2500)]));
  const preview = await debugChatRetrieval(body('大树最佳阵容'), dependencies({ getMetaDecks: async () => bulky }));
  assert.equal(preview.tools[0].result.truncated, true);
  assert.equal(Object.hasOwn(preview.tools[0].result, 'data'), false);
  assert.deepEqual(preview.recall.rows, []);
  assert.equal(preview.ranking[0].metric, null);
  assert.deepEqual(JSON.parse(preview.modelContext[1].content), JSON.parse(serializeToolResult(preview.tools[0].result)));
});

test('observed emblem sourceDeck rows and unknown source clocks stay explicit in local traces', () => {
  const id = beginDeveloperTrace({ question: '来源转职阵容' });
  const output = { status: 'source_match', sourceDeck: { id: 'observed-emblem', name: '来源转职阵容',
    stats: { sampleSize: 140, avgPlacement: 4 }, evidence: { source: 'OP.GG MCP', delivery: 'version_cache', fetchedAt: null, sourceTime: null, sourcePatch: null } },
    data: { note: 'non-array data cannot crash tracing' }, citation: '[S2]' };
  recordDeveloperTool(id, { name: 'get_emblem_team', phase: 'prefetch', args: { item_id: 'emblem' }, output,
    serialized: serializeToolResult(output), startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), evidence: [{ id: 'S2', title: '来源' }] });
  finishDeveloperTrace(id, { status: 'completed' });
  const trace = getDeveloperTrace(id);
  assert.equal(trace.statRows[0].sourcePath, 'sourceDeck'); assert.equal(trace.statRows[0].sourceRowId, 'observed-emblem');
  assert.equal(trace.statRows[0].stats.sampleSize, 140);
  assert.equal(trace.cache.reads[0].delivery, 'version_cache'); assert.equal(trace.cache.reads[0].ageSeconds, null);
  assert.equal(trace.cache.reads[0].sourceTime, null);
  const altered = getDeveloperTrace(id); altered.tools.length = 0;
  assert.equal(getDeveloperTrace(id).tools.length, 1, 'returned details are detached snapshots');
});

test('untrusted oversized metadata obeys the hard trace cap, and retention is bounded with an actual TTL', () => {
  const id = beginDeveloperTrace({ question: '容量边界' });
  const oversized = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`field${index}`, 'untrusted'.repeat(6000)]));
  setDeveloperTraceContext(id, { mode: 'current_version_only', requested: oversized });
  const output = { status: 'cached', data: [], evidence: { fetchedAt: null, sourceTime: null } };
  recordDeveloperTool(id, { name: 'search_catalog', phase: 'model', args: oversized, output, serialized: serializeToolResult(output),
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), evidence: [{ id: 'S1', title: '容量测试', ...oversized }] });
  finishDeveloperTrace(id, { status: 'completed' });
  const trace = getDeveloperTrace(id);
  assert.equal(trace.storageTruncated, true);
  assert.ok(JSON.stringify(trace).length <= developerTraceRetention.maxTraceChars);
  assert.ok(trace.omissions || trace.modelContext.some(segment => segment.truncated));

  const oldest = beginDeveloperTrace({ question: '应被容量淘汰' });
  for (let index = 0; index < developerTraceRetention.maxTraces; index++) beginDeveloperTrace({ question: `保留-${index}` });
  assert.equal(getDeveloperTrace(oldest), null);
  assert.equal(listDeveloperTraces({ limit: 999 }).total, 50);
  assert.equal(listDeveloperTraces({ limit: 999 }).limit, 50);
  const retained = listDeveloperTraces({ limit: 1 }).traces[0];
  const originalNow = Date.now;
  Date.now = () => Date.parse(retained.expiresAt) + 1;
  try { assert.equal(getDeveloperTrace(retained.id), null); }
  finally { Date.now = originalNow; }
});
