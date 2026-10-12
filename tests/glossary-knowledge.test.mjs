import test from 'node:test';
import assert from 'node:assert/strict';
import { getGlossary, matchGlossaryTerms } from '../server/knowledge/glossary.mjs';
import { buildKnowledgeBundle } from '../server/knowledge/bundle.mjs';
import { knowledgeInScope, isGeneralGlossary } from '../server/knowledge/scope.mjs';
import { searchKnowledge } from '../server/knowledge/service.mjs';
import { inheritSnapshotPatchAssignments, eligibleChunks } from '../server/storage/repository.mjs';
import { MilvusClient, indexProfile } from '../server/knowledge/vector.mjs';
import { contentHash } from '../server/knowledge/chunking.mjs';

const glossary = getGlossary();
const bundle = buildKnowledgeBundle({ glossary });
const docMap = new Map(bundle.documents.map(doc => [doc.id, doc]));
const chunks = bundle.chunks.map(chunk => ({ ...chunk, kind: 'glossary', document: docMap.get(chunk.documentId).payload, source: docMap.get(chunk.documentId).source }));
const release = { id: 'fixture-glossary-release', currentPatch: '18.4', season: 18 };
const config = { embedding: { model: 'fixture', dimensions: 3, baseUrl: '', key: '' } };
const deps = { corpus: { release, chunks }, config, databaseMode: false };

test('one authored concept becomes one immutable document and atomic chunk, without a fabricated game patch', () => {
  assert.equal(glossary.entries.length, 191);
  assert.equal(bundle.documents.length, 191); assert.equal(bundle.chunks.length, 191);
  assert.equal(new Set(glossary.entries.map(entry => entry.id)).size, 191);
  assert.ok(glossary.entries.every(entry => entry.scope === 'general' && entry.sourcePatch === null && entry.examples.length && entry.misconceptions.length));
  assert.ok(chunks.every(chunk => isGeneralGlossary(chunk) && knowledgeInScope(chunk, '18.5')));
  assert.ok(bundle.documents.every(doc => doc.source.kind === 'project_editorial' && doc.source.name === '本项目术语整理'));
  const copy = getGlossary(); copy.entries[0].definition = '外部修改';
  assert.notEqual(getGlossary().entries[0].definition, copy.entries[0].definition);
  assert.match(glossary.entries.find(entry => entry.term === '锁血').misconceptions[0], /不是无敌机制/);
  assert.match(glossary.entries.find(entry => entry.term === '神装').misconceptions[0], /不意味着必胜/);
});

test('terminology matcher recognizes common aliases and comparisons without substring matches in English identifiers', () => {
  assert.deepEqual(new Set(matchGlossaryTerms('慢d和大D有什么区别').map(entry => entry.term)), new Set(['慢D', '大D']));
  assert.ok(matchGlossaryTerms('搜卡什么意思').some(entry => entry.term === 'D牌'));
  assert.ok(matchGlossaryTerms('主c的职责').some(entry => entry.term === '主C'));
  assert.equal(matchGlossaryTerms('ADC_Draven_unknown').length, 0);
  assert.equal(matchGlossaryTerms('今天吃什么').length, 0);
});

test('general exception never admits patch-unknown mechanics or statistics disguised with a scope property', () => {
  const valid = chunks[0];
  for (const invalid of [{ ...valid, kind: 'library' }, { ...valid, kind: 'statistics' },
    { ...valid, sourcePatch: '18.3' }, { ...valid, document: { ...valid.document, editorialRevision: null } },
    { ...valid, eligible: false }]) assert.equal(knowledgeInScope(invalid, '18.4'), false);
});

test('exact glossary matches outrank incidental gold reward text and preserve both concepts for comparisons', async () => {
  const noise = { id: 'noise', documentId: 'library:gold', title: '慢D金币奖励', text: '慢D 大D 金币', sourcePatch: '18.4', entityIds: [], payload: {}, kind: 'library', eligible: true };
  const result = await searchKnowledge({ query: '慢D和大D有什么区别', limit: 2 }, { ...deps, corpus: { release, chunks: [noise, ...chunks] } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(new Set(result.evidence.map(entry => entry.title)), new Set(['慢D', '大D']));
  assert.ok(result.evidence.every(entry => entry.scope === 'general' && entry.sourcePatch === null && entry.source.kind === 'project_editorial'));
});

test('exact-match priority uses the published corpus aliases rather than silently reading a different code revision', async () => {
  const current = structuredClone(chunks[0]); current.document.aliases.push('发布词典的新叫法');
  const noise = { id: 'noise', documentId: 'library:noise', title: '发布词典的新叫法', text: '发布词典的新叫法', sourcePatch: '18.4', entityIds: [], payload: {}, kind: 'library', eligible: true };
  const result = await searchKnowledge({ query: '发布词典的新叫法', limit: 1 }, { ...deps, corpus: { release, chunks: [noise, current] } });
  assert.equal(result.evidence[0].documentId, current.documentId);
});

test('glossary edits change chunk identity, release-keyed cache and cached evidence rehydrates from the authoritative corpus', async () => {
  const changed = structuredClone(glossary); changed.entries[0].definition += '修订说明。';
  assert.throws(() => buildKnowledgeBundle({ glossary: changed }), /editorial metadata/);
  changed.revision = `editorial-v1-${contentHash(changed.entries).slice(0, 16)}`; changed.source.revision = changed.revision;
  const changedBundle = buildKnowledgeBundle({ glossary: changed });
  assert.notEqual(changedBundle.chunks[0].id, bundle.chunks[0].id);
  let key1, key2;
  await searchKnowledge({ query: 'D牌', limit: 1 }, { ...deps, cacheSet: async key => { key1 = key; } });
  await searchKnowledge({ query: 'D牌', limit: 1 }, { ...deps, corpus: { release: { ...release, id: 'changed' }, chunks }, cacheSet: async key => { key2 = key; } });
  assert.notEqual(key1, key2); assert.ok(key1.startsWith('knowledge:v5:'));
  const result = await searchKnowledge({ query: '锁血', limit: 1 }, deps);
  const cached = { ...result, evidence: [{ ...result.evidence[0], text: '保证全胜' }] };
  const restored = await searchKnowledge({ query: '锁血', limit: 1 }, { ...deps, cacheGet: async () => cached });
  assert.match(restored.evidence[0].text, /不是无敌机制/); assert.doesNotMatch(restored.evidence[0].text, /保证全胜/);
});

test('SQL corpus scope requires both chunk and document approval and only permits explicit editorial glossary rows', async () => {
  let sql, args;
  const db = { execute: async (query, values) => { sql = query; args = values; return [[]]; } };
  assert.deepEqual(await eligibleChunks(release, db), []);
  assert.deepEqual(args, [release.id, '18.4', '18.4']);
  assert.match(sql, /c\.eligible=1 AND d\.eligible=1/);
  assert.match(sql, /c\.source_patch IS NULL/); assert.match(sql, /d\.kind='glossary'/);
  assert.match(sql, /editorialRevision/);
});

test('statistics attribution inheritance requires exact content identity and same season/patch, preserving source nulls', async () => {
  let sql, args;
  const connection = { execute: async (query, values) => { sql = query; args = values; return [{ affectedRows: 201 }]; } };
  assert.equal(await inheritSnapshotPatchAssignments(connection, { fromRelease: 'old', toRelease: 'new', patch: '18.4' }), 201);
  assert.deepEqual(args, ['old', 'new', '18.4']);
  for (const check of ['target.content_hash=original.content_hash', 'new_release.season=old_release.season', 'new_release.source_patch=old_release.source_patch', 'original.source_patch IS NULL', 'target.source_patch IS NULL', "original.evidence_kind='statistics'", "'$.contentHash'", "'$.assignedPatch'"]) assert.ok(sql.includes(check), check);
  assert.equal(await inheritSnapshotPatchAssignments({ execute: () => assert.fail('same release must be a no-op') }, { fromRelease: 'same', toRelease: 'same', patch: '18.4' }), 0);
});

test('Milvus validates general scopes per expected ID and rejects a foreign patch dressed as general', async () => {
  const client = new MilvusClient(config);
  const rows = [{ id: 'glossary', release_id: release.id, source_patch: '', scope: 'general', eligible: true },
    { id: 'rule', release_id: release.id, source_patch: '18.4', scope: 'patch', eligible: true }];
  client.call = async () => rows;
  assert.deepEqual(await client.verifyEntities('fixture', release, ['glossary', 'rule'], new Map([['glossary', 'general'], ['rule', 'patch']])), { count: 2 });
  rows[0].source_patch = '18.3';
  await assert.rejects(client.verifyEntities('fixture', release, ['glossary', 'rule']), { code: 'INDEX_VERIFY_FAILED' });
  assert.equal(indexProfile(config).scopeSchema, 'patch-or-editorial-glossary-v1');
});
