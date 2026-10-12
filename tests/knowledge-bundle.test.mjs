import test from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog } from '../server/data.mjs';
import { getLibrarySnapshot } from '../server/library-data.mjs';
import { getSeasonMechanic } from '../server/mechanics-data.mjs';
import { buildKnowledgeBundle } from '../server/knowledge/bundle.mjs';
import { tableGroups } from '../server/knowledge/chunking.mjs';
import { getGlossary } from '../server/knowledge/glossary.mjs';

const catalog = await getCatalog();
const [library, mechanics] = await Promise.all([getLibrarySnapshot({ catalog }), getSeasonMechanic({ catalog })]);
assert.equal(library.status, 'ready');
assert.equal(mechanics.entries.length, 349);
const bundle = buildKnowledgeBundle({ catalog, library, mechanics });

test('real seed separates entities, upstream source documents and project glossary cards', () => {
  assert.equal(bundle.entities.length, 844);
  assert.equal(bundle.documents.filter(doc => doc.kind !== 'glossary').length, 641);
  assert.equal(bundle.chunks.filter(doc => doc.kind !== 'glossary').length, 749);
  assert.equal(bundle.documents.filter(doc => doc.kind !== 'glossary' && doc.eligible).length, 596);
  assert.equal(bundle.documents.length, 641 + getGlossary().entries.length);
  assert.equal(new Set(bundle.entities.map(entity => entity.id)).size, bundle.entities.length);
  assert.equal(new Set(bundle.documents.map(doc => doc.id)).size, bundle.documents.length);
  assert.equal(new Set(bundle.chunks.map(chunk => chunk.id)).size, bundle.chunks.length);
  assert.deepEqual(buildKnowledgeBundle({ catalog, library, mechanics }), bundle);
  assert.ok(bundle.chunks.every(chunk => /^chunk:[a-f0-9]{64}$/.test(chunk.id) && /^[a-f0-9]{64}$/.test(chunk.contentHash)));
  const ids = new Set(bundle.entities.map(entity => entity.id));
  assert.ok(bundle.documents.every(doc => doc.entityIds.every(id => ids.has(id))));
  assert.ok(bundle.entities.find(entity => entity.id === 'champion:DA_18_Veigar').aliases.includes('小法'));
  assert.ok(bundle.entities.find(entity => entity.id === 'augment:DA_TraitLadder').aliases.includes('Trait Ladder'));
});

test('six-trait reward retrieval keeps both 50% branches together with headers, denominator and rule context', () => {
  const chunks = bundle.chunks.filter(chunk => chunk.documentId === 'library:trait-ladder');
  const chunk = chunks.find(chunk => chunk.payload.condition === '6种非独特羁绊');
  assert.ok(chunk.eligible);
  assert.deepEqual(chunk.payload.table.rows.map(row => [row.probability, row.cells[2]]), [[0.5, '7金币'], [0.5, '2个3费弈子']]);
  assert.match(chunk.text, /羁绊种类数 \| 概率 \| 奖励内容/);
  assert.match(chunk.text, /领取该奖励分支的概率/);
  assert.match(chunk.text, /独特羁绊不计入/);
  assert.match(chunk.text, /适用补丁：18\.4/);
  assert.equal(chunks.filter(row => row.payload.table?.rows.some(branch => branch.condition === '6种非独特羁绊')).length, 1);
});

test('every source table row survives once, including long reference tables; parent sources and images are exact', () => {
  for (const doc of library.documents) {
    const parent = bundle.documents.find(row => row.id === `library:${doc.id}`);
    assert.deepEqual(parent.payload, doc);
    assert.deepEqual(parent.source, doc.source);
    doc.tables.forEach((table, tableIndex) => {
      const chunks = bundle.chunks.filter(chunk => chunk.documentId === parent.id && chunk.payload.tableIndex === tableIndex);
      const rows = chunks.flatMap(chunk => chunk.payload.rowIndices.map((index, offset) => ({ index, row: chunk.payload.table.rows[offset] }))).sort((a, b) => a.index - b.index);
      assert.deepEqual(rows.map(row => row.index), table.rows.map((_, index) => index), `${doc.id}/${tableIndex}`);
      assert.deepEqual(rows.map(row => row.row), table.rows);
      assert.ok(chunks.every(chunk => chunk.payload.table.note === table.note && chunk.payload.table.probabilityBasis === table.probabilityBasis));
    });
  }
  const orbs = bundle.chunks.filter(chunk => chunk.documentId === 'library:loot-orb-contents' && chunk.payload.kind === 'table');
  assert.equal(orbs.length, 7);
  assert.ok(orbs.every(chunk => Math.abs(chunk.payload.table.rows.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-9));
});

test('probability groups stay atomic above the soft size limit and table notes are retained', () => {
  const table = { title: '两种奖励', columns: ['条件', '概率', '奖励'], probabilityBasis: '一次兑现', note: '仅玩家战斗触发。', exhaustive: true,
    rows: [{ condition: '6羁绊', probability: 0.5, cells: ['6羁绊', '50%', '甲'.repeat(2000)] }, { condition: '6羁绊', probability: 0.5, cells: ['6羁绊', '50%', '乙'.repeat(2000)] }] };
  assert.equal(tableGroups(table, 100).length, 1);
  assert.equal(tableGroups({ ...table, rows: table.rows.map(({ condition, ...row }) => row) }, 100).length, 1);
  const changed = structuredClone(library);
  changed.documents = [{ ...changed.documents[0], tables: [table] }]; changed.augmentRules = [];
  const result = buildKnowledgeBundle({ catalog, library: changed });
  const chunk = result.chunks.find(row => row.payload.kind === 'table');
  assert.match(chunk.text, /表下注释：仅玩家战斗触发。/);
  assert.equal(chunk.payload.table.rows.length, 2);
});

test('unknown, conflicting and wrong-patch knowledge never gains eligibility from the asset version', () => {
  assert.equal(catalog.context.gamePatch, null);
  for (const id of ['sprykin', 'frontline-foundation', 'bonus-gift', 'star-scaling', 'patch-schedule']) {
    const doc = bundle.documents.find(row => row.id === `library:${id}`);
    assert.equal(doc.eligible, false, id);
    assert.ok(bundle.chunks.filter(chunk => chunk.documentId === doc.id).every(chunk => !chunk.eligible));
  }
  const changed = structuredClone(library);
  changed.documents = [{ ...changed.documents[0], sourcePatch: null, retrievalEligible: true }]; changed.augmentRules = [];
  assert.equal(buildKnowledgeBundle({ catalog, library: changed }).documents[0].eligible, false);
  const current = structuredClone(catalog); current.context.gamePatch = '18.5';
  assert.ok(buildKnowledgeBundle({ catalog: current, library, mechanics }).documents.filter(doc => doc.kind !== 'glossary').every(doc => !doc.eligible));
  const wrongSet = structuredClone(library); wrongSet.context.set = 17;
  assert.ok(buildKnowledgeBundle({ catalog, library: wrongSet }).documents.filter(doc => doc.kind !== 'glossary').every(doc => !doc.eligible));
  const wrongPage = structuredClone(library); wrongPage.documents[0].source.pagePatch = '18.3';
  assert.equal(buildKnowledgeBundle({ catalog, library: wrongPage }).documents[0].eligible, false);
});

test('offering documents preserve variants, cooldown units and uncertainty while excluding all source conflicts', () => {
  const doc = bundle.documents.find(row => row.id === 'wisp-offering:DA_18_HeatedRivalry');
  assert.equal(doc.eligible, true);
  assert.equal(doc.sourcePatch, '18.4');
  assert.equal(doc.payload.offeringConditions.cooldown.unit, 'wisp_shops');
  assert.equal(doc.payload.offeringConditions.cooldown.trigger, 'offered');
  assert.equal(doc.payload.offeringConditions.offerConditions.eligibilityGuaranteed, false);
  assert.equal(doc.payload.offeringConditions.probability.value, null);
  const chunk = bundle.chunks.find(row => row.documentId === doc.id);
  assert.match(chunk.text, /满足它们不保证出现/);
  assert.match(chunk.text, /无法计算实际概率/);
  for (const entry of mechanics.entries.filter(row => row.offeringConditions.conflicts.length)) {
    assert.equal(bundle.documents.find(row => row.id === `wisp-offering:${entry.id}`).eligible, false, entry.id);
  }
  for (const entry of mechanics.entries.filter(row => row.offeringConditions.status === 'not_documented')) {
    const missing = bundle.documents.find(row => row.id === `wisp-offering:${entry.id}`);
    assert.equal(missing.sourcePatch, null); assert.equal(missing.eligible, false);
  }
});

test('content changes replace chunk hashes without mutating source objects or unrelated chunks', () => {
  const changed = structuredClone(library), before = JSON.stringify(changed);
  buildKnowledgeBundle({ catalog, library: changed, mechanics });
  assert.equal(JSON.stringify(changed), before);
  const ladder = changed.documents.find(doc => doc.id === 'trait-ladder');
  ladder.tables[0].rows.find(row => row.condition === '6种非独特羁绊').cells[2] = '来源更新后的奖励';
  const updated = buildKnowledgeBundle({ catalog, library: changed, mechanics });
  const original = bundle.chunks.find(chunk => chunk.documentId === 'library:trait-ladder' && chunk.payload.condition === '6种非独特羁绊');
  const revised = updated.chunks.find(chunk => chunk.documentId === original.documentId && chunk.ordinal === original.ordinal);
  assert.notEqual(revised.contentHash, original.contentHash); assert.notEqual(revised.id, original.id);
  assert.deepEqual(updated.chunks.filter(chunk => chunk.documentId === 'library:shop-odds'), bundle.chunks.filter(chunk => chunk.documentId === 'library:shop-odds'));
});
