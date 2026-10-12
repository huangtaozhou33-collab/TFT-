// Explicit live acceptance check. The application can call its configured paid
// embedding provider for uncached queries. Never read or print credentials here.
import { readFile, writeFile } from 'node:fs/promises';

if (!process.argv.includes('--allow-provider')) {
  console.error('Live retrieval may call the configured embedding provider. Run with --allow-provider to opt in.');
  process.exit(1);
}
const base = new URL(process.env.RAG_CHECK_URL || 'http://127.0.0.1:3001');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:' || base.username || base.password || base.search || base.hash) {
  console.error('RAG_CHECK_URL must be a credential-free local HTTP address.');
  process.exit(1);
}
async function request(path, body) {
  const response = await fetch(new URL(path, base), {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Local application returned HTTP ${response.status}.`);
  return response.json();
}
try {
  const health = await request('/api/storage');
  if (health.milvus?.indexed !== true) throw new Error('The active knowledge index is not ready.');
  const cases = JSON.parse(await readFile(new URL('../tests/fixtures/rag-live-cases.json', import.meta.url), 'utf8'));
  const results = [];
  for (const row of cases) {
    const result = await request('/api/knowledge/query', { query: row.query, limit: 6, ...(row.entityId ? { entityId: row.entityId } : {}) });
    const evidence = result.evidence || [];
    const match = evidence.findIndex(entry => entry.documentId === row.expectedDocumentId && (row.requiredText || []).every(text => entry.text.includes(text)));
    const patchIsolated = evidence.every(entry => entry.sourcePatch === health.activeRelease.currentPatch);
    const imagesPresent = row.id !== 'blue_loot_orb_stage_four' || match >= 0 && evidence[match].images?.length > 0;
    const passed = patchIsolated && imagesPresent && result.retrieval?.mode === 'hybrid'
      && (row.expectNoEvidence ? result.status === 'not_found' && evidence.length === 0 : result.status === 'ready' && match >= 0);
    const observation = { id: row.id, query: row.query, passed, status: result.status, retrieval: result.retrieval,
      expectedRank: match >= 0 ? match + 1 : null, patchIsolated, imagesPresent,
      evidence: evidence.map(entry => ({ id: entry.id, documentId: entry.documentId, title: entry.title, sourcePatch: entry.sourcePatch, imageCount: entry.images?.length || 0 })) };
    results.push(observation);
    console.log(JSON.stringify({ id: row.id, passed, mode: result.retrieval?.mode, expectedRank: observation.expectedRank }));
  }
  const first = cases[0];
  const cached = await request('/api/knowledge/query', { query: first.query, entityId: first.entityId, limit: 6 });
  const report = { checkedAt: new Date().toISOString(), releaseId: health.activeRelease.id, patch: health.activeRelease.currentPatch,
    indexedChunks: health.milvus.indexedChunks, cacheHit: cached.retrieval?.cacheHit === true,
    passed: results.filter(row => row.passed).length, total: results.length, results,
    scope: `${cases.length} retrieval smoke cases; not a complete quality benchmark or a chat-generation evaluation.` };
  await writeFile(new URL('../docs/RAG_LIVE_VALIDATION.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, total: report.total, cacheHit: report.cacheHit, report: 'docs/RAG_LIVE_VALIDATION.json' }));
  if (report.passed !== report.total || !report.cacheHit) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', message: error.message }));
  process.exitCode = 1;
}
