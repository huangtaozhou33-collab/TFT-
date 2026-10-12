import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getExplorerSnapshot, normalizeExplorerRows } from '../server/explorer-data.mjs';

const catalog = {
  champions: [{ id: 'native', name: '原生英雄', cost: 2, traits: ['法师'] }, { id: 'carrier', name: '持有者', cost: 3, traits: ['战士'] }],
  traits: [{ id: 'mage', name: '法师' }, { id: 'warrior', name: '战士' }],
  items: [{ id: 'emblem', name: '法师纹章', category: 'emblem', kind: 'completed', traitId: 'mage' }, { id: 'sword', name: '成装', category: 'core', kind: 'completed' }],
};
const stats = { sampleSize: 100, avgPlacement: 4.1, top4Rate: .55, winRate: .15, pickRate: .9 };
const evidence = { source: 'fixture', sourcePatch: null, population: null, sampleDenominator: 'source occurrence count' };

test('holder and build percentages keep source denominators without inventing overall rates', () => {
  const holders = normalizeExplorerRows('items', { data: [{ championId: 'carrier', itemId: 'sword', stats }], evidence }, catalog);
  assert.equal(holders.length, 1);
  assert.deepEqual(holders[0].unitIds, ['carrier']);
  assert.deepEqual(holders[0].itemIds, ['sword']);
  assert.deepEqual(holders[0].traitIds, ['warrior']);
  assert.equal(holders[0].stats.pickRate, null);
  assert.equal(holders[0].stats.avgLevel, null);
  assert.equal(holders[0].evidence.sourcePickRate, .9);
  assert.equal(holders[0].evidence.traitMembership, 'catalog_native_champion');
  assert.equal(holders[0].evidence.jointPopulationAvailable, false);
  assert.equal(holders[0].evidence.population, null);
});

test('emblem research excludes native trait carriers and unmapped emblems', () => {
  const result = { evidence, data: ['native', 'carrier'].map(championId => ({ championId, itemId: 'emblem', stats })) };
  const rows = normalizeExplorerRows('emblems', result, catalog);
  assert.deepEqual(rows.map(row => row.championId), ['carrier']);
  assert.equal(rows[0].emblemTraitId, 'mage');
  assert.equal(rows[0].kind, 'emblem_holder');
  const unknown = structuredClone(catalog); delete unknown.items[0].traitId;
  assert.equal(normalizeExplorerRows('emblems', result, unknown).length, 0);
});

test('a source build keeps repeated item slots and does not invent unseen entities', () => {
  const result = { evidence, data: [{ championId: 'carrier', itemIds: ['sword', 'sword', 'emblem'], stats }, { championId: 'carrier', itemIds: ['unmapped'], stats }] };
  const rows = normalizeExplorerRows('champions', result, catalog, 'carrier');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].itemIds, ['sword', 'sword', 'emblem']);
  assert.equal(rows[0].stats.sampleSize, 100);
  assert.equal(normalizeExplorerRows('champions', result, catalog, 'native').length, 0);
});

test('trait tiers retain their source threshold and independent patch', () => {
  const result = { evidence: { ...evidence, source: 'Tactics.tools', sourcePatch: '18.4' }, data: [{ id: 'mage__2', traitId: 'mage', tier: 2, minUnits: 4, stats }] };
  const [row] = normalizeExplorerRows('traits', result, catalog);
  assert.equal(row.threshold, 4);
  assert.equal(row.tier, 2);
  assert.deepEqual(row.unitIds, []);
  assert.equal(row.evidence.sourcePatch, '18.4');
  assert.equal(row.evidence.traitMembership, 'observed_source_trait_tier');
});

test('overall rows do not turn recommended items or native traits into observed combinations', () => {
  const result = { evidence, data: [{ id: 'carrier', topItems: ['sword'], stats: { ...stats, pickRate: .25 } }] };
  const [unit] = normalizeExplorerRows('units', result, catalog);
  assert.equal(unit.kind, 'champion_overall');
  assert.deepEqual(unit.itemIds, []);
  assert.deepEqual(unit.traitIds, ['warrior']);
  assert.equal(unit.stats.pickRate, .25);
  assert.equal(unit.evidence.jointPopulationAvailable, false);
  const [item] = normalizeExplorerRows('equipment', { evidence, data: [{ id: 'sword', stats: { ...stats, pickRate: .1 } }] }, catalog);
  assert.equal(item.kind, 'item_overall');
  assert.deepEqual(item.unitIds, []);
  assert.deepEqual(item.traitIds, []);
});

test('all explorer snapshots can be read with outbound network disabled and no synthetic totals', async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls++; throw new Error('Network disabled'); };
  try {
    const current = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
    for (const tab of ['units', 'equipment', 'decks', 'champions', 'items', 'emblems', 'traits']) {
      const snapshot = await getExplorerSnapshot(tab);
      assert.equal(snapshot.delivery, 'version_cache');
      assert.equal(snapshot.context.set, current.context.set);
      assert.equal(snapshot.context.assetVersion, current.context.assetVersion);
      assert.equal(snapshot.summary.rowCount, snapshot.rows.length);
      assert.equal(snapshot.summary.sampleSize, null);
      assert.equal(snapshot.summary.avgPlacement, null);
      assert.equal(snapshot.capabilities.jointMatchQueries, false);
      assert.equal(new Set(snapshot.rows.map(row => row.id)).size, snapshot.rows.length);
      assert.ok(snapshot.rows.every(row => row.evidence.querySemantics === 'cached_aggregate_row_membership'));
    }
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = original; }
});

test('invalid explorer dimensions cannot silently return a different population', async () => {
  await assert.rejects(getExplorerSnapshot('regional_winrate'), { status: 400, code: 'INVALID_EXPLORER_TAB' });
});
