import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendEmblemTeam } from '../server/emblem.mjs';

const trait = { id: 'mage', name: '法师', effects: [{ minUnits: 2 }, { minUnits: 4 }, { minUnits: 6 }] };
const catalog = { items: [{ id: 'emblem', name: '法师纹章', category: 'emblem', allocationVerified: false }, { id: 'sword', name: '大剑', category: 'component' }], traits: [trait, { id: 'tank', name: '护卫', effects: [{ minUnits: 2 }] }],
  champions: [
    { id: 'holder', name: '持有者', cost: 4, traits: ['护卫'] },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `mage-${index}`, name: `法师${index}`, cost: 1 + index % 5, traits: ['法师'] })),
    { id: 'lux-a', name: '拉克丝 (甲)', cost: 5, traits: ['法师'] }, { id: 'lux-b', name: '拉克丝 (乙)', cost: 5, traits: ['护卫'] },
    { id: 'tank', name: '承伤者', cost: 5, traits: ['护卫'] },
  ] };
const recommend = (extra = {}, source = { data: [] }) => recommendEmblemTeam({ itemId: 'emblem', championId: 'holder', ...extra }, catalog, source);

test('only an actual source emblem on this exact holder is treated as an observed team', () => {
  const deck = (id, items, avg, sample) => ({ id, name: id, units: [{ id: 'holder', items }, { id: 'mage-0', items: [] }], stats: { avgPlacement: avg, sampleSize: sample } });
  const source = { data: [deck('no-emblem', [], 1, 1000), deck('tiny', ['emblem'], 1, 1), deck('verified', ['emblem'], 3.2, 500)], evidence: { source: 'fixture' } };
  const before = structuredClone(source);
  const result = recommend({}, source);
  assert.equal(result.status, 'source_match');
  assert.equal(result.sourceDeck.id, 'verified');
  assert.equal(result.teamSize, 2);
  assert.deepEqual(result.holderItems, ['emblem']);
  assert.equal(result.sourceDeck.evidence.source, 'fixture');
  assert.deepEqual(source, before);
});

test('simulation preserves the holder and uses unique current units without invented statistics or repeated forms', () => {
  const before = structuredClone(catalog);
  const result = recommend();
  assert.equal(result.status, 'simulation');
  assert.equal(result.team.length, 8);
  assert.equal(result.team.filter(unit => unit.holdsEmblem).length, 1);
  assert.equal(result.team.find(unit => unit.holdsEmblem).id, 'holder');
  assert.equal(new Set(result.team.map(unit => unit.name.replace(/\s*\(.*$/, ''))).size, 8);
  assert.equal(result.traits.find(row => row.id === 'mage').activeThreshold, 6);
  assert.equal(Object.hasOwn(result, 'sourceDeck'), false);
  assert.equal(Object.hasOwn(result, 'stats'), false);
  assert.match(result.note, /模拟搭配/);
  assert.deepEqual(catalog, before);
});

test('unknown mappings, non-emblems and redundant native holders do not produce imaginary rosters', () => {
  assert.equal(recommend({ itemId: 'sword' }).status, 'unavailable');
  assert.equal(recommend({ championId: 'not-in-catalog' }).status, 'unavailable');
  assert.equal(recommend({ championId: 'mage-0' }).status, 'unavailable');
  assert.equal(recommend({ teamSize: 20 }).status, 'unavailable');
  const unknown = { ...catalog, items: [{ id: 'unknown', name: '未知纹章', category: 'emblem' }] };
  assert.equal(recommendEmblemTeam({ itemId: 'unknown', championId: 'holder' }, unknown).status, 'unavailable');
});
