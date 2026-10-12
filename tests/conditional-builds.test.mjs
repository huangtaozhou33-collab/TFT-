import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { selectConditionalBuilds, validateBuildQuery, buildQueryFromExplorer } from '../public/build-query.js';
import { normalizeExplorerQuery, encodeExplorerQuery, decodeExplorerQuery } from '../public/explorer.js';
import { getConditionalChampionBuild } from '../server/conditional-builds.mjs';
import { namedBuildItems, resolveBuildIntent } from '../server/build-intent.mjs';
import { answerChat, debugChatRetrieval } from '../server/chat.mjs';
import { getResearchResults } from '../server/research.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const hero = catalog.champions.find(x => /Veigar$/.test(x.id));
const artifact = catalog.items.find(x => /Dawncore$/.test(x.id));
const blue = catalog.items.find(x => x.name === '蓝霸符');
const crit = catalog.items.find(x => x.name === '珠光护手');
const gun = catalog.items.find(x => x.name === '海克斯科技枪刃');
const stats = (avgPlacement, sampleSize, winRate = .2) => ({ avgPlacement, sampleSize, winRate, top4Rate: .65 });
const row = (itemIds, average, sampleSize, extras = {}) => ({ championId: hero.id, itemIds, stats: stats(average, sampleSize), ...extras });
const rows = [
  row([artifact.id, blue.id, crit.id], 3.2, 400),
  row([gun.id, artifact.id, crit.id], 3.4, 600, { stats: stats(3.4, 600, .4) }),
  row([artifact.id, blue.id, gun.id], 1.1, 12),
  row([blue.id, gun.id, crit.id], 2.0, 5000),
  row([artifact.id, blue.id], 1.0, 900),
  row([artifact.id, blue.id, crit.id], 1.0, 900, { championId: 'another-hero' }),
];
const input = { championId: hero.id, requiredItemIds: [artifact.id] };
const evidence = { source: 'OP.GG MCP', fetchedAt: '2026-10-07T14:00:00.000Z', sourcePatch: null, population: null, sampleDenominator: 'itemCount (champion occurrences with this build)' };
const source = { status: 'live', delivery: 'version_cache', data: rows, evidence };
const deps = { getCatalog: async () => catalog, getChampionBuild: async () => source,
  getSeasonMechanic: async () => ({ status: 'not_cached', entries: [] }),
  getLibrarySnapshot: async () => ({ status: 'not_cached', documents: [], augmentRules: [] }) };

test('fixed-item search ranks complete observed triples and never substitutes an unconditioned best build', () => {
  const before = structuredClone(rows);
  const selected = selectConditionalBuilds(rows, input, catalog);
  assert.equal(selected.status, 'ok');
  assert.deepEqual(selected.best.itemIds, [artifact.id, blue.id, crit.id]);
  assert.equal(selected.best.stats.avgPlacement, 3.2);
  assert.equal(selected.selection.matchedRows, 3);
  assert.equal(selected.selection.qualifiedRows, 2);
  assert.equal(selected.selection.samplesCombined, false);
  assert.ok(selected.data.every(row => row.itemIds.length === 3 && row.itemIds.includes(artifact.id)));
  assert.deepEqual(rows, before);
  assert.equal(selectConditionalBuilds(rows, { ...input, sort: 'winRate' }, catalog).best.stats.winRate, .4);
});

test('two fixed items, exclusions, inclusive sample threshold and empty results preserve the requested conditions', () => {
  const result = selectConditionalBuilds(rows, { ...input, requiredItemIds: [artifact.id, crit.id], excludedItemIds: [gun.id], minSample: 400 }, catalog);
  assert.equal(result.data.length, 1);
  assert.deepEqual(result.best.completionItemIds, [blue.id]);
  assert.equal(result.best.fixedItemCount, 2);
  const small = selectConditionalBuilds(rows, { ...input, minSample: 601 }, catalog);
  assert.equal(small.status, 'insufficient_samples'); assert.equal(small.best, null); assert.deepEqual(small.data, []);
  const absent = selectConditionalBuilds(rows, { ...input, excludedItemIds: [blue.id, crit.id] }, catalog);
  assert.equal(absent.status, 'empty'); assert.equal(absent.best, null);
});

test('invalid slots, missing IDs, components and contradictory or malformed conditions fail closed', () => {
  const component = catalog.items.find(item => item.kind === 'component');
  for (const patch of [{ requiredItemIds: [artifact.id, blue.id, crit.id, gun.id] }, { requiredItemIds: ['missing'] }, { requiredItemIds: [component.id] }, { excludedItemIds: [artifact.id] }, { requiredItemIds: artifact.id }, { requiredItemIds: [null] }]) {
    assert.equal(validateBuildQuery({ ...input, ...patch }, catalog).valid, false);
    assert.equal(selectConditionalBuilds(rows, { ...input, ...patch }, catalog).best, null);
  }
  const unique = { ...catalog, items: catalog.items.map(item => item.id === artifact.id ? { ...item, unique: true } : item) };
  assert.equal(validateBuildQuery({ ...input, requiredItemIds: [artifact.id, artifact.id] }, unique).valid, false);
});

test('duplicate item requirements use counts, and repeated source permutations are not added together', () => {
  const duplicateRows = [row([artifact.id, blue.id, blue.id], 3.6, 220), row([blue.id, artifact.id, blue.id], 3.6, 220), ...rows];
  const result = selectConditionalBuilds(duplicateRows, { ...input, requiredItemIds: [blue.id, blue.id] }, catalog);
  assert.equal(result.data.length, 1); assert.equal(result.best.stats.sampleSize, 220);
  assert.deepEqual(result.best.itemIds, [blue.id, blue.id, artifact.id]);
});

test('saved explorer conditions preserve build mode, ordering, exclusions and sample minimum', () => {
  const explorer = { mode: 'builds', tab: 'champions', operator: 'all', include: [{ type: 'champion', id: hero.id }, { type: 'item', id: artifact.id }], exclude: [{ type: 'item', id: gun.id }], minSample: 500, sort: 'winRate' };
  const restored = decodeExplorerQuery(encodeExplorerQuery(explorer));
  assert.equal(restored.mode, 'builds');
  assert.deepEqual(buildQueryFromExplorer(restored), { ...input, excludedItemIds: [gun.id], minSample: 500, sort: 'winRate', sortDirection: 'desc' });
  assert.equal(buildQueryFromExplorer({ ...restored, operator: 'any' }), null);
  assert.equal(buildQueryFromExplorer({ ...restored, include: [...restored.include, { type: 'champion', id: 'second' }] }), null);
  assert.equal(Object.hasOwn(normalizeExplorerQuery({}), 'mode'), false);
});

test('conditioned server response keeps the original provenance and never borrows Tactics patch or rank', async () => {
  const result = await getConditionalChampionBuild(input, deps);
  assert.equal(result.status, 'ok'); assert.deepEqual(result.evidence, evidence);
  assert.equal(result.evidence.sourcePatch, null); assert.equal(result.evidence.population, null);
  assert.equal(result.champion.id, hero.id);
  const missing = await getConditionalChampionBuild(input, { ...deps, getChampionBuild: async () => ({ status: 'not_cached', data: [], evidence, reason: 'missing' }) });
  assert.equal(missing.status, 'not_cached'); assert.equal(missing.best, null);
});

test('Chinese and English item names, nicknames and exclusions become precise fixed item IDs', () => {
  const intended = resolveBuildIntent('小法带上黎明核心之后最佳三件套是什么，排除科技枪，最低样本500', catalog, { championId: hero.id });
  assert.deepEqual(intended, { ...input, excludedItemIds: [gun.id], minSample: 500, sort: 'avgPlacement', sortDirection: 'asc' });
  assert.deepEqual(resolveBuildIntent('Veigar with Dawncore 最佳三件套', catalog, { championId: hero.id }).requiredItemIds, [artifact.id]);
  const matched = namedBuildItems('小法固定黎明核心排除科技枪', catalog);
  assert.deepEqual(matched.map(x => [x.item.id, x.excluded]), [[artifact.id, false], [gun.id, true]]);
  assert.equal(namedBuildItems('法爆', catalog)[0].item.id, crit.id);
});

test('Agent prefetch answers 小法 + 黎明核心 using conditional triples outside the statistics page', async () => {
  const result = await answerChat({ messages: [{ role: 'user', content: '小法带上黎明核心之后最佳三件套是什么？' }], pageContext: { view: 'library', readonly: true } }, { ...deps,
    chatCompletion: async () => { throw new Error('a precise conditional lookup should not need a model'); } });
  assert.equal(result.answerMode, 'conditional_statistics');
  assert.match(result.reply, /黎明核心＋蓝霸符＋珠光护手/);
  assert.match(result.reply, /平均名次 3.2/); assert.match(result.reply, /样本 400/);
  assert.ok(result.evidence.some(entry => result.reply.includes(`[${entry.id}]`) && entry.title.includes('固定装备')));
  assert.equal(result.suggestedActions.length, 0);
});

test('Agent directly reports an absent fixed-item build without calling a model or fetching ordinary lineup substitutes', async () => {
  const result = await answerChat({ messages: [{ role: 'user', content: '小法固定黎明核心最佳三件套，排除科技枪和蓝霸符，最低样本1000' }] }, { ...deps,
    getMetaDecks: async () => { throw new Error('no ordinary deck fallback'); },
    chatCompletion: async () => { throw new Error('no model needed for the empty-result message'); } });
  assert.equal(result.answerMode, 'conditional_statistics');
  assert.match(result.reply, /未收录/);
  assert.doesNotMatch(result.reply, /蓝霸符＋|科技枪刃＋/);
});

test('Agent inherits page constraints and sample minimum, ignores forged metrics, and allows an explicit different hero', async () => {
  const explorer = { mode: 'builds', tab: 'champions', include: [{ type: 'champion', id: hero.id }, { type: 'item', id: artifact.id }], exclude: [], minSample: 500, sort: 'winRate', sortDirection: 'desc', selectedRow: { id: 'forged', stats: { winRate: 1, sampleSize: 99999999 } } };
  const preview = await debugChatRetrieval({ question: '按当前条件最佳三件套是什么？', pageContext: { view: 'stats', explorer } }, deps);
  const tool = preview.tools.find(tool => tool.name === 'get_conditional_builds');
  assert.ok(tool);
  // The preview exposes the exact submitted JSON, not a second calculation.
  assert.ok(JSON.stringify(preview).includes('"selectedRowVerified":false') || JSON.stringify(preview).includes('\\"selectedRowVerified\\":false'));
  const contextIntent = resolveBuildIntent('按当前条件最佳三件套', catalog, { explorer });
  assert.equal(contextIntent.minSample, 500); assert.equal(contextIntent.sort, 'winRate');
  const other = catalog.champions.find(champion => champion.id !== hero.id);
  const changed = resolveBuildIntent('带上黎明核心最佳三件套', catalog, { championId: other.id, explorer });
  assert.equal(changed.championId, other.id); assert.equal(changed.minSample, 100);
});

test('Agent receives new search-box holder and minimum-sample conditions', async () => {
  const research = { conditions: [{ type: 'champion', id: hero.id }, { type: 'item', id: artifact.id, holderId: hero.id }], carrierId: hero.id, minSample: 500, sort: 'avgPlacement' };
  const preview = await debugChatRetrieval({ question: '当前条件最佳三件套是什么？', pageContext: { view: 'explorer', research } }, {...deps,
    getResearchResults: (query, dependencies) => getResearchResults(query, {...dependencies, databaseMode:false, getMetaDecks:async()=>({status:'ok',data:[],evidence})}),
  });
  const result = preview.tools.find(tool => tool.name === 'get_research_stats').result;
  assert.equal(result.query.minSample, 500);
  assert.equal(result.query.carrierId, hero.id);
  assert.deepEqual(result.query.conditions, research.conditions);
  assert.equal(result.equipment.rows.length, 1); assert.equal(result.equipment.rows[0].stats.sampleSize, 600);
});

test('Agent retains all multi-champion conditions instead of querying an unconstrained single-hero build', async () => {
  const other = catalog.champions.find(champion => champion.id !== hero.id);
  const research = { conditions: [{ type: 'champion', id: hero.id }, { type: 'champion', id: other.id }, { type: 'item', id: artifact.id, holderId: hero.id }], carrierId: hero.id, minSample: 100 };
  const preview = await debugChatRetrieval({ question: '解释当前条件的查询结果', pageContext: { view: 'explorer', research } }, { ...deps,
    getResearchResults: async (query, dependencies) => {
      assert.equal(query.carrierId, hero.id);assert.deepEqual(query.conditions, research.conditions);
      return getResearchResults(query, {...dependencies,databaseMode:true,allowMetaTft:false,getRiotResearchResults:async()=>({query,status:'empty',source:'riot',equipment:{rows:[],evidence},teammates:{rows:[],evidence},comps:{rows:[],evidence},coverage:{jointMatchQueries:true,matchedParticipants:0}})});
    },
    getMetaDecks: async () => { throw new Error('must not replace empty Riot results with unrelated lineups'); },
    getChampionBuild: async () => { throw new Error('must not ignore second champion'); }
  });
  const result = preview.tools.find(tool => tool.name === 'get_research_stats').result;
  assert.ok(!preview.tools.some(tool => tool.name === 'get_conditional_builds'));
  assert.equal(result.jointMatchQueries, true);
  assert.equal(result.query.carrierId, hero.id);
  assert.equal(result.comps.rows.length, 0); assert.equal(result.equipment.rows.length, 0);
  assert.equal(result.query.conditions.length, 3);
});
