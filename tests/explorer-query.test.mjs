import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeExplorerQuery, filterExplorerRows, sortExplorerRows,
  getRowEntities, encodeExplorerQuery, decodeExplorerQuery,
} from '../public/explorer.js';

// Independent aggregate records, not individual matches or reconstructed boards.
const rows = [
  { id: 'frontline', kind: 'champion_build', championId: 'maokai', name: '茂凯出装',
    itemIds: ['stoneplate', 'warmog'], traitIds: ['juggernaut'],
    stats: { sampleSize: 800, avgPlacement: 4.1, top4Rate: 0.5 } },
  { id: 'carry', kind: 'champion_build', championId: 'azir', name: '阿兹尔出装',
    itemIds: ['rageblade', 'gunblade', 'deathcap'], traitIds: ['executioner'],
    stats: { sampleSize: 500, avgPlacement: 3.2, top4Rate: 0.64 } },
  { id: 'mixed', kind: 'deck', name: '示例阵容', unitIds: ['maokai', 'azir'],
    itemIds: ['stoneplate', 'rageblade'], traitIds: ['juggernaut', 'executioner'],
    stats: { sampleSize: 300, avgPlacement: 3.8, top4Rate: 0.6 } },
];
const index = {
  champion: new Map([
    ['maokai', { name: '茂凯', aliases: ['大树'], cost: 5 }],
    ['azir', { name: '阿兹尔', aliases: ['沙皇', 'Azir'], cost: 4 }],
  ]),
  item: new Map([
    ['stoneplate', { name: '石像鬼石板甲', aliases: ['板甲'] }],
    ['rageblade', { name: '鬼索的狂暴之刃', aliases: ['羊刀', 'Guinsoo'] }],
  ]),
  trait: new Map([
    ['executioner', { name: '裁决使', aliases: ['Executioner'] }],
  ]),
};
const ids = values => values.map(row => row.id);
const condition = (type, id) => ({ type, id });

test('AND, OR and NOT operate on the same aggregate row; NOT wins over OR', () => {
  const include = [condition('champion', 'maokai'), condition('item', 'rageblade')];
  assert.deepEqual(ids(filterExplorerRows(rows, { include, operator: 'all' })), ['mixed']);
  assert.deepEqual(ids(filterExplorerRows(rows, { include, operator: 'any' })), ['frontline', 'carry', 'mixed']);
  assert.deepEqual(ids(filterExplorerRows(rows, {
    include, operator: 'any', exclude: [condition('champion', 'azir')],
  })), ['frontline']);
  assert.deepEqual(ids(filterExplorerRows(rows, {
    include, operator: 'all', exclude: [condition('item', 'rageblade')],
  })), []);
});

test('conditions cannot combine different rows or confuse champion and item identities', () => {
  const separateBuilds = rows.slice(0, 2);
  assert.deepEqual(filterExplorerRows(separateBuilds, {
    include: [condition('champion', 'maokai'), condition('item', 'rageblade')],
  }), [], 'a champion from one build and an item from another are not a matching combination');
  assert.deepEqual(filterExplorerRows(separateBuilds, {
    include: [condition('item', 'warmog'), condition('item', 'gunblade')],
  }), [], 'equipment criteria must coexist in a recorded row');
  assert.deepEqual(filterExplorerRows(rows, { include: [condition('champion', 'rageblade')] }), []);
});

test('duplicate chips mean presence, while unknown IDs stay restrictive and safe', () => {
  const input = { include: [condition('item', 'rageblade'), condition('item', 'rageblade')] };
  const original = structuredClone(input);
  assert.deepEqual(normalizeExplorerQuery(input).include, [condition('item', 'rageblade')]);
  assert.deepEqual(ids(filterExplorerRows(rows, input)), ['carry', 'mixed']);
  assert.deepEqual(input, original, 'normalizing and filtering do not mutate query chips');
  for (const id of ['unknown-item', '__proto__', 'constructor']) {
    assert.deepEqual(filterExplorerRows(rows, { include: [condition('item', id)] }, index), []);
    assert.deepEqual(ids(filterExplorerRows(rows, { exclude: [condition('item', id)] }, index)), ids(rows));
  }
  assert.deepEqual(normalizeExplorerQuery({ include: [null, {}, { type: 'match', id: 'frontline' }, condition('item', '')] }).include, []);
});

test('row entities use recorded entity fields, never query chips or alleged match data', () => {
  const row = {
    unitIds: ['maokai', 'maokai', null], championId: 'azir',
    itemIds: ['stoneplate', 42], itemId: 'rageblade', traitIds: ['executioner'],
    include: [condition('item', 'injected-item')], exclude: [condition('champion', 'injected-hero')],
    matches: [{ championId: 'injected-hero', itemIds: ['injected-item'] }],
  };
  assert.deepEqual(getRowEntities(row), {
    champion: ['maokai', 'azir'], item: ['stoneplate', 'rageblade'], trait: ['executioner'],
  });
  assert.deepEqual(filterExplorerRows([{ ...row, stats: { sampleSize: 500 } }], {
    include: [condition('item', 'injected-item')],
  }), []);
  assert.deepEqual(getRowEntities({ unitIds: 'maokai', itemIds: { 0: 'rageblade' }, traitIds: 42 }), {
    champion: [], item: [], trait: [],
  }, 'malformed entity lists are not split into characters or interpreted as real entities');
  assert.deepEqual(getRowEntities(null), { champion: [], item: [], trait: [] });
  assert.deepEqual(ids(filterExplorerRows([null, ...rows], {})), ids(rows));
});

test('sample thresholds are inclusive and exclude unknown samples when a minimum is required', () => {
  const samples = [99, 100, '101', null, undefined, false, '', ' ', 'unknown', Infinity];
  const candidates = samples.map((sampleSize, position) => ({ id: `sample-${position}`, stats: { sampleSize } }));
  assert.deepEqual(ids(filterExplorerRows(candidates, {})), ['sample-1', 'sample-2']);
  assert.deepEqual(ids(filterExplorerRows(candidates, { minSample: 101 })), ['sample-2']);
  assert.equal(filterExplorerRows(candidates, { minSample: 0 }).length, candidates.length, 'zero deliberately disables the sample filter');
  assert.deepEqual(ids(filterExplorerRows(candidates, { minSample: -1 })), ['sample-1', 'sample-2']);
});

test('unknown statistics sort last in either direction without changing input rows', () => {
  const candidates = [
    { id: 'missing', stats: {} }, { id: 'low', stats: { avgPlacement: 2.5 } },
    { id: 'null', stats: { avgPlacement: null } }, { id: 'high', stats: { avgPlacement: '4.2' } },
    { id: 'false', stats: { avgPlacement: false } }, { id: 'blank', stats: { avgPlacement: ' ' } },
    { id: 'invalid', stats: { avgPlacement: 'unknown' } },
  ];
  const originalOrder = ids(candidates);
  assert.deepEqual(ids(sortExplorerRows(candidates, { sort: 'avgPlacement', sortDirection: 'asc' })),
    ['low', 'high', 'missing', 'null', 'false', 'blank', 'invalid']);
  assert.deepEqual(ids(sortExplorerRows(candidates, { sort: 'avgPlacement', sortDirection: 'desc' })),
    ['high', 'low', 'missing', 'null', 'false', 'blank', 'invalid']);
  assert.deepEqual(ids(candidates), originalOrder);
  assert.deepEqual(ids(sortExplorerRows(rows, { sort: 'sampleSize' })), ['frontline', 'carry', 'mixed']);
});

test('search understands entity names and aliases; cost and sample filters still apply', () => {
  assert.deepEqual(ids(filterExplorerRows(rows, { search: ' 大树 ' }, index)), ['frontline', 'mixed']);
  assert.deepEqual(ids(filterExplorerRows(rows, { search: '阿兹尔' }, index)), ['carry', 'mixed']);
  assert.deepEqual(ids(filterExplorerRows(rows, { search: 'AZIR' }, index)), ['carry', 'mixed']);
  assert.deepEqual(ids(filterExplorerRows(rows, { search: '羊刀' }, index)), ['carry', 'mixed']);
  assert.deepEqual(ids(filterExplorerRows(rows, { search: '裁决使' }, index)), ['carry', 'mixed']);
  assert.deepEqual(ids(filterExplorerRows(rows, { search: '大树', cost: 4, minSample: 400 }, index)), []);
  assert.deepEqual(ids(filterExplorerRows(rows, { search: '大树', cost: 4 }, index)), ['mixed']);
  assert.deepEqual(ids(filterExplorerRows(rows, { search: '示例阵容' }, index)), ['mixed']);
  assert.deepEqual(ids(filterExplorerRows(rows, { search: '沙皇' }, { champion: Object.fromEntries(index.champion) })), ['carry', 'mixed']);
});

test('URL round trips preserve only validated query fields, not results, matches or draft actions', () => {
  const query = {
    tab: 'champions', perspective: 'item', operator: 'any',
    include: [condition('champion', 'maokai'), condition('champion', 'maokai')],
    exclude: [condition('item', 'unknown-item')], search: '大树', minSample: 350,
    sort: 'top4Rate', sortDirection: 'desc', horizontal: false, autocomplete: false, page: 3,
    matches: rows, results: { id: 'injected' }, selectedRow: rows[0], draft: { units: ['fake'] },
  };
  const normalized = normalizeExplorerQuery(query);
  const url = new URL('http://localhost:3000/#stats');
  url.searchParams.set('explorer', encodeExplorerQuery(query));
  const restored = decodeExplorerQuery(url.searchParams.get('explorer'));
  assert.deepEqual(restored, normalized);
  for (const tab of ['units', 'equipment', 'items', 'traits', 'champions', 'decks', 'emblems']) {
    assert.equal(decodeExplorerQuery(encodeExplorerQuery({ tab })).tab, tab, 'new and existing public tabs survive saved URLs');
  }
  for (const field of ['matches', 'results', 'selectedRow', 'draft']) assert.equal(Object.hasOwn(restored, field), false);
  assert.deepEqual(ids(filterExplorerRows(rows, restored, index)), ['frontline'], 'restored sample threshold still excludes the 300-sample lineup');

  const invalid = decodeExplorerQuery(JSON.stringify({ tab: 'workbench', perspective: 'other', operator: 'sql',
    sort: 'unverifiedWinRate', sortDirection: 'up', minSample: -50, page: 0,
    search: 'x'.repeat(300), include: [condition('item', 'x'.repeat(181))], exclude: 'rageblade' }));
  assert.equal(invalid.tab, 'units'); assert.equal(invalid.perspective, 'champion');
  assert.equal(invalid.operator, 'all'); assert.equal(invalid.sort, 'avgPlacement');
  assert.equal(invalid.sortDirection, 'asc'); assert.equal(invalid.minSample, 100); assert.equal(invalid.page, 1);
  assert.equal(invalid.search.length, 160); assert.deepEqual(invalid.include, []); assert.deepEqual(invalid.exclude, []);
  for (const value of [null, 42, '', '{', 'null', '[]', '"query"', 'x'.repeat(16001)]) assert.equal(decodeExplorerQuery(value), null);
  assert.deepEqual(normalizeExplorerQuery(null), normalizeExplorerQuery({}));
});
