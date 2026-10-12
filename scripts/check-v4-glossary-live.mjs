// Explicit live acceptance. Only query texts go to the configured embedding
// provider; no chat model is called. Never load or print credential files.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

if (!process.argv.includes('--allow-provider')) {
  console.error('Live retrieval may call the configured embedding provider. Use --allow-provider to opt in.');
  process.exit(1);
}
const base = new URL(process.env.RAG_CHECK_URL || 'http://127.0.0.1:3001');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:' || base.username || base.password || base.search || base.hash) {
  console.error('RAG_CHECK_URL must be a credential-free local HTTP address.');
  process.exit(1);
}
const request = async (path, body) => {
  const response = await fetch(new URL(path, base), {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Local application returned HTTP ${response.status}.`);
  return response.json();
};
const cases = [
  { query: '速八是什么意思？', ids: ['fast-eight', 'fast-eighth'], ambiguous: true },
  { query: '卡牌是什么意思？', ids: ['deny-units', 'twisted-fate'], ambiguous: true },
  { query: '启动是什么意思？', ids: ['spend-start', 'combat-start'], ambiguous: true },
  { query: '他说先吃利息，是什么意思？', ids: ['earn-interest'] },
  { query: '请给我番茄炒蛋的做法', ids: [] },
];
try {
  const health = await request('/api/storage');
  assert.equal(health.backend, 'mysql');
  assert.equal(health.milvus?.indexed, true, 'The active knowledge index must be ready.');
  const { entries } = JSON.parse(await readFile(new URL('../data/glossary/zh-CN.v4.json', import.meta.url), 'utf8'));
  const results = [];
  for (const row of cases) {
    const result = await request('/api/knowledge/query', { query: row.query, limit: 2 });
    const evidence = result.evidence || [];
    const found = evidence.filter(entry => entry.kind === 'glossary');
    const checks = {
      currentRelease: result.releaseId === health.activeRelease.id,
      hybrid: result.retrieval?.mode === 'hybrid' && result.retrieval?.vectorStatus === 'ready',
      expectedCards: row.ids.every(id => found.some(entry => entry.documentId === `glossary:${id}`)),
      scope: evidence.every(entry => entry.scope === 'general' ? entry.kind === 'glossary' && entry.sourcePatch === null : entry.sourcePatch === health.activeRelease.currentPatch),
      originalContent: row.ids.every(id => {
        const card = entries.find(entry => entry.id === id);
        const actual = found.find(entry => entry.documentId === `glossary:${id}`);
        return card && actual && actual.text.includes(card.definition) && actual.text.includes(card.disambiguation)
          && actual.evidenceStatus === card.evidenceStatus && actual.verificationStatus === 'not_independently_verified';
      }),
      ambiguity: !row.ambiguous || result.terminology?.mentions.some(mention => mention.ambiguous && row.ids.every(id => mention.candidates.some(candidate => candidate.id === id))),
      status: row.ids.length ? result.status === 'ready' : result.status === 'not_found' && evidence.length === 0,
    };
    const observation = { query: row.query, passed: Object.values(checks).every(Boolean), checks, status: result.status,
      retrieval: result.retrieval, terminology: result.terminology,
      evidence: evidence.map(entry => ({ documentId: entry.documentId, title: entry.title, scope: entry.scope, sourcePatch: entry.sourcePatch, evidenceStatus: entry.evidenceStatus, verificationStatus: entry.verificationStatus })) };
    results.push(observation);
    console.log(JSON.stringify({ query: row.query, passed: observation.passed, mode: result.retrieval?.mode }));
  }
  const cached = await request('/api/knowledge/query', { query: cases[0].query, limit: 2 });
  const report = { checkedAt: new Date().toISOString(), releaseId: health.activeRelease.id, indexedChunks: health.milvus.indexedChunks,
    cacheHit: cached.retrieval?.cacheHit === true, passed: results.filter(row => row.passed).length, total: results.length,
    providerUseExplicit: true, chatModelCalled: false, results,
    limitation: 'Real retrieval smoke checks, not a generated-answer or full quality evaluation. Cached requests do not call the embedding provider.' };
  await writeFile(new URL('../docs/V4_GLOSSARY_LIVE_VALIDATION.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, total: report.total, cacheHit: report.cacheHit }));
  if (report.passed !== report.total || !report.cacheHit) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', message: error.message }));
  process.exitCode = 1;
}
