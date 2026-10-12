import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getCompsOverview, hasObservedCompStatistics, buildObservedRelatedComps } from '../server/comps.mjs';
import { getCatalog, getMetaDecks } from '../server/data.mjs';
import { cacheContext } from '../scripts/stats-cache.mjs';

// Synthetic source records are test material only, never application content.
function sourceDeck(id, ids = ['A', 'B', 'C', 'D'], { cores = ['A'], stats, evidence, variants } = {}) {
  return {
    id, name: `fixture-${id}`,
    units: ids.map((unitId, index) => ({ id: unitId, name: unitId, items: [`item-${unitId}`], isCore: cores.includes(unitId), star: 2, cell: { x: index + 1, y: 2 } })),
    traits: [{ id: 'fixture-trait', name: 'fixture trait', count: 2 }],
    stats: stats || { avgPlacement: 4.3, top4Rate: 0.51, winRate: 0.1, pickRate: null, sampleSize: 1200 },
    evidence: evidence || { source: 'fixture source', delivery: 'version_cache', recordHash: createHash('sha256').update(id).digest('hex') },
    variants: variants || [],
  };
}

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

test('real version cache contains ten source comps with their own evidence and no network reads', async t => {
  // Both reads must use the same clock; otherwise crossing a second changes only age.
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('comp overview must read local version cache'); };
  try {
    const [overview, source, catalog] = await Promise.all([getCompsOverview(), getMetaDecks(), getCatalog()]);
    assert.equal(calls, 0);
    assert.equal(overview.status, 'ready');
    assert.equal(overview.delivery, 'version_cache');
    assert.equal(overview.data.length, 10);
    assert.equal(new Set(overview.data.map(deck => deck.id)).size, 10);
    assert.deepEqual(overview.context, cacheContext(catalog));
    const knownChampions = new Set(catalog.champions.map(champion => champion.id));
    const sourceById = new Map(source.data.map(deck => [deck.id, deck]));
    for (const deck of overview.data) {
      const original = sourceById.get(deck.id);
      assert.ok(original, `source record ${deck.id} must exist`);
      assert.ok(hasObservedCompStatistics(deck));
      assert.deepEqual(deck.stats, original.stats, 'each comp keeps its own source statistics');
      assert.deepEqual(deck.evidence, original.evidence);
      assert.equal(deck.evidence.delivery, 'version_cache');
      assert.match(deck.evidence.recordHash, /^[a-f0-9]{64}$/);
      assert.deepEqual(deck.context, overview.context);
      assert.deepEqual(deck.units.map(unit => unit.id), original.units.map(unit => unit.id));
      assert.deepEqual(deck.units.map(unit => unit.items), original.units.map(unit => unit.items), 'missing equipment is never filled');
      assert.ok(deck.units.every(unit => knownChampions.has(unit.id)));
      assert.deepEqual(deck.traits, original.traits, 'source trait counts are not fabricated');
      assert.equal(deck.population.unitCount, original.units.length);
      assert.equal(deck.population.finalLevel, null, 'unit count is not invented source level');
      assert.equal(deck.population.method, 'catalog_roster_slots');
      assert.equal(deck.population.requiredSlots,original.units.length + original.units.filter(unit=>unit.id==='DA_18_ElderDragon').length);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('real source positions remain eight complete boards and two entirely unplaced rosters', async () => {
  const [overview, source] = await Promise.all([getCompsOverview(), getMetaDecks()]);
  const sourceById = new Map(source.data.map(deck => [deck.id, deck]));
  let complete = 0; let missing = 0;
  for (const deck of overview.data) {
    const original = sourceById.get(deck.id); const occupied = new Set();
    const placed = deck.units.filter(unit => unit.cell != null);
    assert.deepEqual(deck.positionCoverage, { placed: placed.length, total: deck.units.length });
    assert.equal(deck.coordinateSystem.displayTopY, 4);
    assert.equal(deck.coordinateSystem.columns, 7); assert.equal(deck.coordinateSystem.rows, 4);
    for (let index = 0; index < deck.units.length; index += 1) {
      const cell = deck.units[index].cell; const sourceCell = original.units[index].cell;
      if (cell == null) { assert.equal(sourceCell, null, 'an absent source position stays absent'); continue; }
      assert.ok(Number.isSafeInteger(cell.x) && cell.x >= 1 && cell.x <= 7);
      assert.ok(Number.isSafeInteger(cell.y) && cell.y >= 1 && cell.y <= 4);
      assert.deepEqual(cell, { x: sourceCell.x, y: sourceCell.y }, 'source coordinates are not rotated or replaced');
      assert.ok(!occupied.has(`${cell.x},${cell.y}`)); occupied.add(`${cell.x},${cell.y}`);
    }
    if (placed.length === deck.units.length) complete += 1;
    if (placed.length === 0) {
      missing += 1;
      assert.ok(deck.warnings.some(warning => warning.code === 'source_position_missing'));
      assert.ok(deck.units.every(unit => unit.cell === null));
    }
  }
  assert.equal(complete, 8); assert.equal(missing, 2);
  assert.equal(overview.coverage.positionComplete, 8);
});

test('real related records are existing complete source comps with their own statistics and equipment', async () => {
  const overview = await getCompsOverview(); const sources = new Map(overview.data.map(deck => [deck.id, deck]));
  for (const parent of overview.data) for (const related of parent.variants) {
    const ownSource = sources.get(related.id);
    assert.ok(ownSource, 'related comp must be a separately observed source record');
    assert.notEqual(related.id, parent.id);
    assert.deepEqual(related.stats, ownSource.stats);
    assert.deepEqual(related.evidence, ownSource.evidence);
    assert.deepEqual(related.units, ownSource.units, 'no synthetic substitutions or equipment swaps');
    assert.deepEqual(related.traits, ownSource.traits);
    assert.deepEqual(related.variants, [], 'related records do not recursively invent variants');
    assert.equal(related.relation.kind, 'related_observed_comp');
    assert.equal(related.relation.sourceFamilyVerified, false, 'heuristic overlap is not an official source family');
    const cores = new Set(parent.units.filter(unit => unit.isCore === true).map(unit => unit.id));
    assert.ok(related.relation.sharedCoreIds.length > 0);
    assert.ok(related.relation.sharedCoreIds.every(id => cores.has(id) && related.units.some(unit => unit.id === id && unit.isCore === true)));
    assert.ok(related.relation.rosterOverlap >= 0.5);
  }
});

test('related comp matching requires a shared source core and at least half the smaller distinct roster', () => {
  const parent = sourceDeck('parent');
  const boundary = sourceDeck('boundary', ['A', 'B', 'X', 'Y']);
  const noSharedCore = sourceDeck('no-core', ['A', 'B', 'C', 'D'], { cores: ['B'] });
  const tooLittleOverlap = sourceDeck('too-small', ['A', 'X', 'Y', 'Z']);
  const duplicateCannotInflateOverlap = sourceDeck('duplicate', ['A', 'A', 'X', 'Y']);
  const shorter = sourceDeck('shorter', ['A', 'X']);
  const input = freeze([parent, boundary, noSharedCore, tooLittleOverlap, duplicateCannotInflateOverlap, shorter]);
  const related = buildObservedRelatedComps(parent, input);
  assert.deepEqual(related.map(deck => deck.id), ['boundary', 'shorter']);
  assert.equal(related[0].relation.sharedCount, 2); assert.equal(related[0].relation.rosterOverlap, 0.5);
  assert.equal(related[1].relation.sharedCount, 1); assert.equal(related[1].relation.rosterOverlap, 0.5);
  assert.deepEqual(buildObservedRelatedComps(sourceDeck('without-core', undefined, { cores: [] }), input), []);
});

test('statistically ineligible records never enter related comps, including unknown samples and source evidence', () => {
  const parent = sourceDeck('parent');
  const invalidStats = [
    { sampleSize: 99 }, { sampleSize: 100.5 }, { sampleSize: '1200' }, { sampleSize: null }, { sampleSize: NaN }, { sampleSize: Infinity },
    { avgPlacement: 0 }, { avgPlacement: 8.1 }, { avgPlacement: null }, { avgPlacement: NaN },
    { top4Rate: -0.1 }, { top4Rate: 1.1 }, { top4Rate: '0.5' }, { winRate: null }, { winRate: Infinity },
    { top4Rate: 0.2, winRate: 0.3 },
  ].map((patch, index) => sourceDeck(`bad-stat-${index}`, undefined, { stats: { ...parent.stats, ...patch } }));
  const invalidEvidence = [
    sourceDeck('no-hash', undefined, { evidence: { delivery: 'version_cache' } }),
    sourceDeck('null-hash', undefined, { evidence: { delivery: 'version_cache', recordHash: null } }),
    sourceDeck('not-cache', undefined, { evidence: { delivery: 'live', recordHash: 'example' } }),
  ];
  for (const deck of [...invalidStats, ...invalidEvidence]) assert.ok(!hasObservedCompStatistics(deck), deck.id);
  assert.deepEqual(buildObservedRelatedComps(parent, [...invalidStats, ...invalidEvidence]), []);
  assert.deepEqual(buildObservedRelatedComps(invalidStats[0], [parent]), [], 'an invalid parent cannot recommend related comps');
  const boundary = sourceDeck('minimum-valid', undefined, { stats: { ...parent.stats, sampleSize: 100, avgPlacement: 8, top4Rate: 0, winRate: 0 } });
  assert.ok(hasObservedCompStatistics(boundary));
});

test('database comp evidence accepts verified current-release source rows and preserves related-comp statistics', async () => {
  const source = await getMetaDecks();
  // Statistics and lineups use captured source shapes; patch qualification is
  // synthetic test metadata, never a claim about the captured source patch.
  const releaseId = createHash('sha256').update('verified-mysql-release-fixture').digest('hex');
  const currentPatch = '18.4';
  const rows = source.data.map(deck => ({ ...structuredClone(deck), evidence: {
    ...deck.evidence, delivery: 'mysql', releaseId, sourcePatch: currentPatch, currentPatch,
  } }));
  assert.ok(rows.length > 1);
  for (const row of rows) assert.ok(hasObservedCompStatistics(row), row.id);
  for (const row of rows) {
    const actual = buildObservedRelatedComps(row, rows);
    const expected = buildObservedRelatedComps(source.data.find(deck => deck.id === row.id), source.data);
    assert.deepEqual(actual.map(deck => deck.id), expected.map(deck => deck.id));
    for (const related of actual) {
      const ownSource = rows.find(deck => deck.id === related.id);
      assert.deepEqual(related.stats, ownSource.stats);
      assert.deepEqual(related.evidence, ownSource.evidence);
      assert.deepEqual(related.units, ownSource.units);
    }
  }
  const valid = rows[0];
  for (const evidence of [
    { sourcePatch: null }, { sourcePatch: '' }, { sourcePatch: '18.3' },
    { currentPatch: null }, { currentPatch: '18.5' },
    { releaseId: null }, { releaseId: 'invalid' }, { recordHash: null },
    { delivery: 'live' },
  ]) {
    const invalid = { ...valid, evidence: { ...valid.evidence, ...evidence } };
    assert.ok(!hasObservedCompStatistics(invalid), JSON.stringify(evidence));
    assert.deepEqual(buildObservedRelatedComps(invalid, rows), []);
  }
  assert.ok(!hasObservedCompStatistics({ ...valid, stats: { ...valid.stats, sampleSize: null } }));
  assert.ok(!hasObservedCompStatistics({ ...valid, stats: { ...valid.stats, top4Rate: -0.1 } }));
});

test('related matching retains candidate statistics, ordering and immutable full material rather than parent metrics', () => {
  const parent = sourceDeck('parent', undefined, { stats: { avgPlacement: 2.4, top4Rate: 0.8, winRate: 0.3, pickRate: null, sampleSize: 5000 } });
  const worse = sourceDeck('worse', ['A', 'B', 'C', 'X'], { stats: { avgPlacement: 4.6, top4Rate: 0.45, winRate: 0.08, pickRate: null, sampleSize: 800 } });
  const better = sourceDeck('better', ['A', 'B', 'C', 'Y'], { stats: { avgPlacement: 3.1, top4Rate: 0.7, winRate: 0.2, pickRate: null, sampleSize: 1600 }, variants: [{ id: 'unverified-nested-material' }] });
  const originals = structuredClone([parent, worse, better]);
  freeze(parent); freeze(worse); freeze(better);
  const related = buildObservedRelatedComps(parent, [parent, worse, better]);
  assert.deepEqual(related.map(deck => deck.id), ['better', 'worse']);
  for (const [index, candidate] of [better, worse].entries()) {
    assert.deepEqual(related[index].stats, candidate.stats); assert.notDeepEqual(related[index].stats, parent.stats);
    assert.deepEqual(related[index].units, candidate.units); assert.deepEqual(related[index].evidence, candidate.evidence);
    assert.notEqual(related[index].stats, candidate.stats); assert.notEqual(related[index].units, candidate.units);
  }
  related[0].units[0].items.push('test-only-mutation'); related[0].stats.sampleSize = 1;
  assert.deepEqual([parent, worse, better], originals, 'returned material does not alias or mutate any input source');
});
