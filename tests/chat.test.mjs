import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { answerChat as runChat, serializeToolResult } from '../server/chat.mjs';
import { inferenceSettings } from '../server/env.mjs';
// Legacy budget regression fixtures explicitly exercise a four-call deployment.
const answerChat=(body,deps={})=>runChat(body,{inferenceSettings:{...inferenceSettings(()=>''),maxToolCalls:4,maxRounds:4},...deps});
import { validatePlan } from '../server/planner.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const draft = () => ({ version: 12, units: [{ instanceId: 'mock-unit', championId: catalog.champions[0].id, role: 'carry', priority: 1, lockedItems: [] }], components: {}, completedItems: {}, reserve: {} });
const ask = overrides => ({ messages: [{ role: 'user', content: '查询并解释来源。' }], draft: draft(), ...overrides });
const call = (name, args = {}, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
// Fixed public response shape with synthetic sample metrics. Tests must not read
// ignored raw snapshots, depend on their TTL, or contact a statistics service.
const statisticsFixture = {
  status: 'live', reason: null,
  data: [{ id: 'fixture-maokai-deck', name: '峡谷野怪 茂凯', units: [], traits: [],
    stats: { avgPlacement: 4.2, top4Rate: 0.5, winRate: 0.1, pickRate: 0.05, sampleSize: 100 } }],
  evidence: { source: 'OP.GG MCP', endpoint: 'https://mcp-api.op.gg/mcp', tool: 'tft_list_meta_decks',
    sourceTime: '2026-10-07T12:59:23.000Z', fetchedAt: '2026-10-07T13:36:26.808Z', sourcePatch: null,
    delivery: 'test_fixture', population: null, statisticalWindow: null, unsupportedDimensions: ['gamePatch', 'region', 'rank', 'star'] },
};

test('explorer context rechecks the source row rather than trusting client metrics or joint totals', async () => {
  const champion = catalog.champions[0];
  const item = catalog.items.find(item => item.kind !== 'component');
  const fixture = { status: 'cached', delivery: 'version_cache', rows: [{ id: 'verified-row', kind: 'item_holder', name: champion.name,
    championId: champion.id, itemId: item.id, unitIds: [champion.id], itemIds: [item.id], traitIds: [],
    stats: { sampleSize: 321, avgPlacement: 4.2, top4Rate: .54, winRate: .14, pickRate: null }, evidence: statisticsFixture.evidence }] };
  await withMockProvider((index, request) => {
    assert.equal(index, 0);
    const prefetched = request.messages.filter(message => message.role === 'system').map(message => message.content).find(content => content.includes('selectedRowVerified'));
    assert.ok(prefetched);
    assert.ok(prefetched.includes('"selectedRowVerified":true'));
    assert.ok(prefetched.includes('"sampleSize":321'));
    assert.equal(prefetched.includes('99999999'), false);
    assert.ok(prefetched.includes('"aggregateStatistics":null'));
    assert.ok(prefetched.includes('"jointMatchQueries":false'));
    assert.equal(request.tools.some(tool => tool.function.name === 'plan_equipment'), false);
    return { role: 'assistant', content: '所选携带组合：均次4.2，样本321。[S2]' };
  }, async (requests, askAnswer) => {
    const result = await askAnswer(ask({ messages: [{ role: 'user', content: '解释当前选中行。' }], pageContext: { view: 'stats', readonly: true,
      explorer: { tab: 'items', include: [{ type: 'champion', id: champion.id }, { type: 'item', id: item.id }], operator: 'all', minSample: 100,
        selectedRow: { id: 'verified-row', stats: { sampleSize: 99999999, winRate: 1 } } } } }));
    assert.equal(requests.length, 1);
    assert.equal(result.evidence[1].sourcePatch, null);
    assert.equal(result.suggestedActions.length, 0);
  }, { getExplorerSnapshot: async () => fixture });
});

test('an explorer row excluded by the active conditions cannot be cited as the selected row', async () => {
  const champion = catalog.champions[0];
  const fixture = { status: 'cached', delivery: 'version_cache', rows: [{ id: 'excluded-row', kind: 'champion_build', name: champion.name,
    unitIds: [champion.id], itemIds: [], traitIds: [], stats: { sampleSize: 200, avgPlacement: 1 }, evidence: statisticsFixture.evidence }] };
  await withMockProvider((index, request) => {
    const prefetched = request.messages.filter(message => message.role === 'system').map(message => message.content).find(content => content.includes('selectedRowVerified'));
    assert.ok(prefetched.includes('"matchedRecords":0'));
    assert.ok(prefetched.includes('"selectedRowVerified":false'));
    assert.ok(prefetched.includes('"data":[]'));
    return { role: 'assistant', content: '当前条件没有匹配记录。' };
  }, async (requests, askAnswer) => {
    await askAnswer(ask({ messages: [{ role: 'user', content: '当前条件有什么结果？' }], pageContext: { view: 'stats', readonly: true,
      explorer: { tab: 'champions', exclude: [{ type: 'champion', id: champion.id }], selectedRow: { id: 'excluded-row' } } } }));
  }, { getExplorerSnapshot: async () => fixture });
});

test('equipment recommendations respect selected item conditions while an explicit different hero overrides page context', async () => {
  const maokai = catalog.champions.find(champion => champion.name === '茂凯');
  const ahri = catalog.champions.find(champion => champion.name === '阿狸');
  const items = catalog.items.filter(item => item.kind === 'completed' && (item.slotCost ?? 1) === 1 && item.category === 'core').slice(0, 4);
  assert.equal(items.length, 4);
  const build = championId => ({ status: 'live', evidence: statisticsFixture.evidence, data: [
    { championId, itemIds: items.slice(0, 3).map(item => item.id), stats: { avgPlacement: 2, sampleSize: 200 } },
    { championId, itemIds: [items[0].id, items[1].id, items[3].id], stats: { avgPlacement: 4, sampleSize: 200 } },
  ] });
  for (const explicitOther of [false, true]) {
    const hero = explicitOther ? ahri : maokai;
    await withMockProvider((index, request) => {
      const source = allPrefetchedData(request).find(value => value.selection && value.data?.[0]?.championId);
      assert.ok(source);
      assert.equal(source.data[0].championId, hero.id);
      assert.equal(source.data[0].stats.avgPlacement, explicitOther ? 2 : 4);
      assert.equal(source.data[0].itemIds.includes(items[3].id), !explicitOther);
      return { role: 'assistant', content: '已按实际来源组合回答。' };
    }, async (requests, askAnswer) => {
      await askAnswer(ask({ messages: [{ role: 'user', content: explicitOther ? '阿狸的最佳三件装备。' : '当前条件下茂凯的最佳三件装备。' }],
        pageContext: { view: 'stats', readonly: true, entityId: maokai.id, explorer: { tab: 'champions', minSample: 100,
          include: [{ type: 'champion', id: maokai.id }, { type: 'item', id: items[3].id }] } } }));
    }, { getExplorerSnapshot: async () => ({ status: 'cached', delivery: 'version_cache', rows: [] }), getChampionBuild: async id => build(id) });
  }
});

async function withMockProvider(script, operation, sourceOverrides = {}) {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'local-test-key';
  const requests = [];
  globalThis.fetch = async (url, options) => {
    // Never pass through to the original fetch. A changed upstream/snapshot path
    // is an explicit mock failure, rather than a paid or external request.
    assert.ok(String(url).endsWith('/chat/completions'), 'all non-provider network requests are blocked in this test');
    const request = JSON.parse(options.body);
    requests.push(request);
    const message = await script(requests.length - 1, request);
    return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { 'Content-Type': 'application/json' } });
  };
  const sources = {
    getMetaDecks: async () => structuredClone(statisticsFixture),
    getChampionBuild: async () => ({ status: 'not_cached', data: [], evidence: null, reason: '测试来源未收录' }),
    getItemHolders: async () => ({ status: 'not_cached', data: [], evidence: null, reason: '测试来源未收录' }),
    getTraitStats: async () => ({ status: 'not_cached', data: [], evidence: null, reason: '测试来源未收录' }),
    getSeasonMechanic: async () => ({ status: 'not_cached', entries: [], rating: { status: 'unrated' }, reason: '测试来源未收录' }),
    ...sourceOverrides,
  };
  const askAnswer = body => answerChat(body, sources);
  try { return await operation(requests, askAnswer); }
  finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
  }
}

test('statistics citation IDs reach the model and point to their own source timestamps', async () => {
  let receivedTool;
  await withMockProvider((index, request) => {
    if (index === 0) return { role: 'assistant', content: null, tool_calls: [call('get_meta_decks')] };
    receivedTool = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
    return { role: 'assistant', content: '这是来源样本中的阵容统计。[S2]' };
  }, async (requests, askAnswer) => {
    const result = await askAnswer(ask());
    assert.equal(requests.length, 2);
    assert.equal(receivedTool.citation, '[S2]');
    assert.equal(result.evidence[1].id, 'S2');
    assert.equal(result.evidence[1].type, 'statistics');
    assert.equal(result.evidence[1].fetchedAt, receivedTool.sourceEvidence?.fetchedAt ?? null);
    assert.equal(result.evidence[1].sourceTime, receivedTool.sourceEvidence?.sourceTime ?? null);
    assert.equal(result.evidence[1].sourcePatch, receivedTool.sourceEvidence?.sourcePatch ?? null);
    assert.equal(typeof receivedTool.evidence, 'object', 'structured upstream provenance is retained');
    assert.equal(receivedTool.localTime.timeZone, 'Australia/Sydney');
    assert.ok(receivedTool.localTime.sourceTime.includes('2026/10/07 23:59:23'));
    assert.ok(receivedTool.localTime.fetchedAt.includes('2026/10/08 00:36:26'));
    assert.equal(result.reply.includes('[S2]'), true);
  });
});

test('trait tiers prefetch once with independent Tactics patch and Diamond+ scope, leaving only three tools without lending provenance to OP.GG', async () => {
  const mage = catalog.traits.find(trait => trait.name === '法师');
  const juggernaut = catalog.traits.find(trait => trait.name === '主宰');
  const scope = { source: 'Tactics.tools', url: 'https://tactics.tools/traits', endpoint: 'https://tactics.tools/traits', sourcePatch: '18.4', gamePatch: '18.4',
    set: 18, queue: 'Ranked', rank: 'Diamond+', population: { queue: 'Ranked', rank: 'Diamond+', region: null },
    fetchedAt: '2026-10-07T14:00:00.000Z', sourceTime: '2026-10-07T13:56:35.000Z', sampleDenominator: 'source statsData.traits[key].count (trait-tier occurrences)' };
  const fixture = { status: 'live', delivery: 'version_cache', data: [
    { id: 'mage__1', traitId: mage.id, name: mage.name, tier: 1, level: 4, minUnits: 4, stats: { avgPlacement: 4.6, sampleSize: 1000, top4Rate: 0.45, winRate: 0.08 } },
    { id: 'mage__77', traitId: mage.id, name: mage.name, tier: 77, level: 6, minUnits: 6, stats: { avgPlacement: 3.4, sampleSize: 450, top4Rate: 0.6, winRate: 0.2 } },
    { id: 'mage__3', traitId: mage.id, name: mage.name, tier: 3, level: 9, minUnits: 9, stats: { avgPlacement: 1, sampleSize: 3, top4Rate: 1, winRate: 1 } },
    { id: 'juggernaut__2', traitId: juggernaut.id, name: juggernaut.name, tier: 2, level: 4, minUnits: 4, stats: { avgPlacement: 4, sampleSize: 500, top4Rate: 0.55, winRate: 0.12 } },
    { id: 'excluded', traitId: 'not-in-catalog', name: '不存在羁绊', tier: 1, level: 2, stats: { avgPlacement: 1, sampleSize: 9999 } },
  ], evidence: scope };
  let initial, outputs, reads = 0;
  await withMockProvider((index, request) => {
    if (index === 0) {
      const prefetch = allPrefetchedData(request);
      assert.equal(prefetch.length, 1, 'trait page and trait question share one prefetch');
      initial = prefetch[0];
      assert.ok(request.tools.some(tool => tool.function.name === 'get_trait_stats'));
      assert.match(request.messages[0].content, /该工具明确提供的补丁.*仅适用于其羁绊档位样本/);
      return { role: 'assistant', content: null, tool_calls: [call('get_meta_decks', {}, 'meta'), call('get_current_draft', {}, 'remaining-1'), call('get_current_draft', {}, 'remaining-2'), call('get_current_draft', {}, 'excess')] };
    }
    outputs = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    return { role: 'assistant', content: `比较只适用于此来源的羁绊档位样本。${initial.citation}` };
  }, async (requests, askAnswer) => {
    const input = draft();
    const before = structuredClone(input);
    const result = await askAnswer(ask({ draft: input, pageContext: { view: 'stats', entityId: mage.id }, messages: [{ role: 'user', content: '比较法师和主宰羁绊的各档位表现、平均名次和样本。' }] }));
    assert.equal(reads, 1);
    assert.equal(requests.length, 2);
    assert.deepEqual(input, before);
    assert.ok(initial.data.every(row => [mage.id, juggernaut.id].includes(row.traitId)));
    const comparison = initial.comparisons.find(row => row.traitId === mage.id);
    assert.equal(comparison.bestAvailableTier.level, 6, 'unit threshold comes from level, not source ordinal tier');
    assert.equal(comparison.bestAvailableTier.tier, 77);
    assert.equal(comparison.selection.minimumSampleSize, 100);
    assert.equal(comparison.selection.metric, 'avgPlacement');
    assert.ok(!initial.data.some(row => row.id === 'mage__3'), 'a tiny high-performing sample is excluded from qualified ranking');
    assert.equal(initial.sourceEvidence.sourcePatch, '18.4');
    assert.deepEqual(initial.sourceEvidence.population, scope.population);
    const citation = result.evidence.find(entry => `[${entry.id}]` === initial.citation);
    assert.equal(citation.title, 'Tactics.tools 羁绊档位统计');
    assert.equal(citation.url, scope.url);
    assert.equal(citation.sourcePatch, '18.4');
    assert.deepEqual(citation.population, scope.population);
    assert.equal(citation.fetchedAt, scope.fetchedAt);
    const opgg = outputs[0];
    const opggCitation = result.evidence.find(entry => `[${entry.id}]` === opgg.citation);
    assert.notEqual(opgg.citation, initial.citation);
    assert.equal(opgg.sourceEvidence.population, null);
    assert.equal(opggCitation.sourcePatch, null, 'Tactics patch must never fill OP.GG’s unknown patch');
    assert.ok(outputs.slice(1, 3).every(output => output.draft.version === 12));
    assert.match(outputs[3].error, /工具预算已用完/);
    assert.equal(result.suggestedActions.length, 0);
  }, { getTraitStats: async () => { reads++; return structuredClone(fixture); } });
});

test('OP.GG-only item page and catalog results carry their own static evidence instead of attributing absent facts to CommunityDragon', async () => {
  const item = catalog.items.find(item => item.name === '死亡之蔑' && item.sourceOnly);
  const ordinary = catalog.items.find(item => item.kind === 'completed' && item.source?.description === 'opgg' && item.source?.identity === 'communitydragon');
  const originalRecord = catalog.sources.find(source => source.id === 'opgg-recipes');
  assert.ok(item && ordinary && originalRecord, 'tracked catalog must preserve the independently sourced item and its provenance');
  let pageEntity, search;
  await withMockProvider((index, request) => {
    if (index === 0) {
      const contextMessage = request.messages.find(message => message.role === 'system' && message.content.startsWith('已验证页面数据上下文'));
      pageEntity = JSON.parse(contextMessage.content.slice(contextMessage.content.indexOf('\n') + 1)).entity;
      assert.match(request.messages[0].content, /实体事实优先使用实体的citation\/fieldCitations/);
      return { role: 'assistant', content: null, tool_calls: [call('search_catalog', { kind: 'items', query: `${item.name} ${ordinary.name}` })] };
    }
    search = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
    return { role: 'assistant', content: `死亡之蔑的描述来自补录的装备资料。${pageEntity.citation}` };
  }, async (_requests, askAnswer) => {
    const result = await askAnswer(ask({ pageContext: { view: 'library', entityId: item.id }, messages: [{ role: 'user', content: '死亡之蔑的效果是什么？' }] }));
    assert.equal(pageEntity.kind, 'items');
    assert.equal(pageEntity.itemKind, 'special');
    assert.equal(pageEntity.sourceOnly, true);
    assert.deepEqual(pageEntity.source, item.source);
    assert.notEqual(pageEntity.citation, '[S1]');
    assert.equal(pageEntity.fieldCitations.identity, pageEntity.citation);
    assert.equal(pageEntity.fieldCitations.description, pageEntity.citation);
    const match = search.matched.find(entity => entity.id === item.id);
    assert.equal(match.citation, pageEntity.citation, 'page and search refer to the same entity-level evidence');
    assert.equal(match.sourceOnly, true);
    assert.equal(match.kind, 'items');
    const description = search.matched.find(entity => entity.id === ordinary.id);
    assert.equal(description.fieldCitations.identity, '[S1]', 'CommunityDragon still establishes ordinary item identity');
    assert.notEqual(description.fieldCitations.description, '[S1]', 'OP.GG descriptions get a separate citation even for CommunityDragon identities');
    for (const entity of [match, description]) {
      const source = result.evidence.find(entry => `[${entry.id}]` === entity.citation);
      assert.equal(source.type, 'static');
      assert.equal(source.url, originalRecord.url);
      assert.equal(source.tool, 'tft_list_item_combinations');
      assert.equal(source.fetchedAt, originalRecord.fetchedAt, 'use original collection time rather than catalog build time');
      assert.equal(source.itemTableVersion, originalRecord.sourcePatch);
      assert.equal(source.sourcePatch, null, 'item-table response version is not a statistics patch');
      assert.equal(source.entityId, entity.id);
    }
    assert.ok(result.reply.includes(pageEntity.citation));
  });
});

function prefetchedData(request) {
  const context = request.messages.find(message => message.role === 'system' && message.content.startsWith('按页面上下文预取的已验证工具数据'));
  assert.ok(context, 'verified page data must be present before the first provider request');
  return JSON.parse(context.content.slice(context.content.indexOf('\n') + 1, context.content.lastIndexOf('\n')));
}

function allPrefetchedData(request) {
  return request.messages.filter(message => message.role === 'system' && message.content.startsWith('按页面上下文预取的已验证工具数据'))
    .map(message => JSON.parse(message.content.slice(message.content.indexOf('\n') + 1, message.content.lastIndexOf('\n'))));
}

const maokai = catalog.champions.find(champion => champion.name === '茂凯');
const ahri = catalog.champions.find(champion => champion.name === '阿狸');
const soraka = catalog.champions.find(champion => champion.name === '索拉卡');
const spellweaver = catalog.items.find(item => item.name === '法师纹章');
const normalItems = catalog.items.filter(item => item.kind === 'completed' && (item.slotCost ?? 1) === 1 && item.allocationVerified !== false).slice(0, 3);
const observedArtifact = catalog.items.find(item => item.category === 'artifact' && (item.slotCost ?? 1) === 1 && item.allocationVerified === false);
const observedSourceItems = [observedArtifact, ...normalItems.slice(0, 2)];
const sampleStats = (avgPlacement = 4, sampleSize = 400) => ({ avgPlacement, sampleSize, top4Rate: 0.5, winRate: 0.1 });
const sourceResult = data => ({ status: 'live', data, evidence: structuredClone(statisticsFixture.evidence) });
const heroUnit = (champion, items = [], isCore = false) => ({ id: champion.id, name: champion.name, items, isCore });
const sourceDeck = (id, avgPlacement, sampleSize, isCore, items = normalItems.map(item => item.id)) => ({ id, name: id,
  units: [heroUnit(maokai, items, isCore), heroUnit(soraka)], stats: sampleStats(avgPlacement, sampleSize), evidence: structuredClone(statisticsFixture.evidence) });

function mechanicFixture(expert = false) {
  const descriptionSource = { name: 'CommunityDragon', url: `https://raw.communitydragon.org/${catalog.context.assetVersion}/cdragon/tft/zh_cn.json`,
    assetVersion: catalog.context.assetVersion, fetchedAt: '2026-10-07T13:39:03.456Z', sourcePatch: null };
  const metadataSource = { name: 'Tactics.tools', url: 'https://tactics.tools/info/set-update', fetchedAt: '2026-10-07T15:55:37.469Z', sourcePatch: null };
  const expertSource = { name: 'MetaTFT · Spencer', url: 'https://www.metatft.com/wisp-tiers', author: 'Spencer', type: 'expert',
    fetchedAt: '2026-10-07T15:57:42.000Z', sourceTime: null, sourcePatch: null };
  const source = { name: 'Tactics.tools + CommunityDragon', ...metadataSource, staticSourceURL: descriptionSource.url,
    staticFetchedAt: descriptionSource.fetchedAt, assetVersion: catalog.context.assetVersion };
  const base = { id: 'fixture-wisp-base', name: '测试复苏法杖', nameEn: 'Fixture Recovery', description: '仅本回合：提供来源记载的测试恢复效果。',
    descriptionIncomplete: false, cost: 2, stages: ['Late'], category: 'Combat', categoryName: '战斗', tier: 2, conditions: null,
    upgrade: { variant: 'base', baseId: 'fixture-wisp-base', upgradedId: 'fixture-wisp-upgraded', prismaticId: null }, active: true,
    availability: { status: 'listed_in_current_set_sources', purchaseConditionsVerified: false }, source: { description: 'communitydragon', descriptionSource, metadataSource },
    rating: expert ? { status: 'expert', tier: 'S', sourceKind: 'expert', source: expertSource } : { status: 'unrated', reason: '测试无攻略榜' } };
  const upgraded = { ...structuredClone(base), id: 'fixture-wisp-upgraded', cost: null, stages: null, active: null,
    availability: { status: 'unverified', purchaseConditionsVerified: false }, upgrade: { ...base.upgrade, variant: 'upgraded' },
    rating: expert ? { status: 'expert', tier: 'S', sourceKind: 'expert', source: expertSource } : { status: 'unrated', reason: '测试无攻略榜' } };
  return { status: 'cached', delivery: 'version_cache', context: catalog.context, source, entries: [base, upgraded,
    ...Array.from({ length: 40 }, (_, index) => ({ ...base, id: `irrelevant-${index}`, name: `无关条目${index}`, nameEn: `Other Fixture ${index}` }))],
    mechanic: { id: 'wisps', name: '法杖 / 自然仙灵', summary: '测试机制规则', rules: ['多数只持续一回合，具体以条目为准。'],
      rulesSource: { name: 'Riot Games', url: 'https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/enchanted-wilds-overview/',
        fetchedAt: '2026-10-07T15:57:58.668Z', sourceTime: '2026-07-27T15:00:00.000Z', sourcePatch: null }, upgradeRules: [] },
    coverage: { entries: 42, metadataMissing: 1 }, rating: expert ? { status: 'expert', source: expertSource } : { status: 'unrated', reason: '没有已核验统计或攻略全榜。' } };
}

test('a selected unrated wisp prefetch stays compact, uses the known team and observed source gear without manufacturing a tier or consuming over four tools', async () => {
  let initial, outputs, reads = 0;
  const fixture = mechanicFixture();
  await withMockProvider((index, request) => {
    if (index === 0) {
      initial = allPrefetchedData(request);
      assert.equal(initial.length, 2);
      assert.match(request.messages[0].content, /没有已核验统计或攻略全榜时不得制造S–D榜/);
      assert.match(request.messages[0].content, /必须标“情境推演”/);
      assert.match(request.messages[0].content, /不能当作永久羁绊\/装备/);
      return { role: 'assistant', content: null, tool_calls: [call('get_current_draft', {}, 'free-1'), call('get_current_draft', {}, 'free-2'), call('get_current_draft', {}, 'excess')] };
    }
    outputs = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    return { role: 'assistant', content: '按当前阵容给条件推荐，属情境推演。' };
  }, async (_requests, askAnswer) => {
    const input = draft(); input.units[0].championId = maokai.id;
    const before = structuredClone(input);
    const result = await askAnswer(ask({ draft: input, pageContext: { view: 'mechanics', mechanicEntity: { kind: 'wisp', id: 'fixture-wisp-base' } },
      messages: [{ role: 'user', content: '这根法杖评级和玩法怎样？直接列阵容候选和队友装备。' }] }));
    assert.equal(reads, 1);
    assert.deepEqual(input, before);
    const [mechanic, decks] = initial;
    assert.equal(mechanic.entries.length, 1, 'only the selected variant is sent, rather than the whole knowledge base');
    assert.equal(mechanic.entries[0].id, 'fixture-wisp-base');
    assert.equal(mechanic.rating.status, 'unrated');
    assert.equal(mechanic.entries[0].rating.status, 'unrated');
    assert.equal(Object.hasOwn(mechanic.entries[0].rating, 'tier'), false);
    assert.equal(Object.hasOwn(mechanic.entries[0], 'stats'), false);
    assert.equal(mechanic.draftContext.currentTeam[0].name, maokai.name);
    assert.equal(mechanic.resourceValidated, false);
    assert.deepEqual(mechanic.entries[0].stages, ['Late']);
    assert.equal(mechanic.entries[0].conditions, null);
    for (const [field, url] of [['description', fixture.entries[0].source.descriptionSource.url], ['metadata', fixture.entries[0].source.metadataSource.url]]) {
      const citation = result.evidence.find(entry => `[${entry.id}]` === mechanic.entries[0].fieldCitations[field]);
      assert.equal(citation.url, url);
      assert.equal(citation.sourcePatch, null);
    }
    assert.ok(result.evidence.some(entry => `[${entry.id}]` === mechanic.mechanic.rulesCitation && entry.title.includes('Riot')));
    assert.equal(decks.data.length, 1);
    assert.equal(decks.data[0].id, 'matching-team-source');
    assert.deepEqual(decks.data[0].units.find(unit => unit.id === maokai.id).observedEquipment.map(item => item.id), normalItems.map(item => item.id));
    assert.equal(decks.selection.mechanicEvidence, 'source_lineup_candidate_not_observed_wisp_team');
    assert.equal(decks.selection.currentTeamOverlapFirst, true);
    assert.ok(outputs.slice(0, 2).every(output => output.draft.version === 12));
    assert.match(outputs[2].error, /工具预算已用完/);
    assert.equal(result.suggestedActions.length, 0);
  }, { getSeasonMechanic: async () => { reads++; return structuredClone(fixture); }, getMetaDecks: async () => sourceResult([
    { id: 'unrelated-team', name: '阿狸阵容', units: [heroUnit(ahri)], stats: sampleStats(1, 800) }, sourceDeck('matching-team-source', 4, 500, true),
  ]) });
});

test('wisp expert tiers have a separate non-statistical citation, and same-name upgraded variants never inherit a base rating', async () => {
  const fixture = mechanicFixture(true), captured = [];
  await withMockProvider((_index, request) => {
    captured.push(allPrefetchedData(request)[0]);
    assert.match(request.messages[0].content, /基础版等级继承到升级\/棱彩版/);
    assert.match(request.messages[0].content, /攻略意见，不能说成胜率或统计/);
    return { role: 'assistant', content: '专家等级与情境推荐分别说明。' };
  }, async (_requests, askAnswer) => {
    const results = [];
    for (const id of ['fixture-wisp-base', 'fixture-wisp-upgraded']) results.push(await askAnswer(ask({ pageContext: { view: 'mechanics', mechanicEntity: { kind: 'wisp', id } },
      messages: [{ role: 'user', content: '测试复苏法杖评级是什么？' }] })));
    const base = captured[0].entries[0], upgraded = captured[1].entries[0];
    assert.equal(base.id, 'fixture-wisp-base');
    assert.equal(base.tier, 2, 'source mechanic level remains separate from expert S tier');
    assert.equal(base.rating.tier, 'S');
    assert.equal(base.rating.sourceKind, 'expert');
    const rating = results[0].evidence.find(entry => `[${entry.id}]` === base.rating.citation);
    assert.equal(rating.type, 'expert');
    assert.equal(rating.url, 'https://www.metatft.com/wisp-tiers');
    assert.equal(rating.author, 'Spencer');
    assert.equal(rating.sourcePatch, null, 'no other page’s patch is borrowed');
    assert.notEqual(base.rating.citation, base.citation);
    assert.equal(Object.hasOwn(base, 'stats'), false);
    assert.equal(upgraded.id, 'fixture-wisp-upgraded');
    assert.equal(upgraded.upgrade.variant, 'upgraded');
    assert.equal(upgraded.rating.status, 'unrated', 'even accidentally duplicated fixture metadata cannot transfer base rating');
    assert.equal(Object.hasOwn(upgraded.rating, 'tier'), false);
  }, { getSeasonMechanic: async () => structuredClone(fixture) });
});

test('readonly mechanics exclude the placeholder board, preserve unknown availability and do not substitute effects for unknown IDs', async () => {
  let initial, outputs;
  await withMockProvider((index, request) => {
    if (index === 0) {
      initial = allPrefetchedData(request)[0];
      assert.match(request.messages[0].content, /可获得性未核验的变体，不是全部能买到/);
      return { role: 'assistant', content: null, tool_calls: [call('get_current_draft', {}, 'read'), call('get_season_mechanic', { id: 'does-not-exist' }, 'unknown')] };
    }
    outputs = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    return { role: 'assistant', content: '只能讨论已记录效果与条件推荐。' };
  }, async (_requests, askAnswer) => {
    const result = await askAnswer(ask({ draft: { version: 17, units: [], components: {}, completedItems: {}, reserve: {} },
      pageContext: { view: 'mechanics', readonly: true, mechanicEntity: { kind: 'wisp', id: 'fixture-wisp-upgraded' } },
      messages: [{ role: 'user', content: '这个法杖能S级吗，怎么变阵？' }] }));
    assert.equal(initial.draftContext.available, false);
    assert.equal(initial.draftContext.draftExcluded, true);
    assert.equal(Object.hasOwn(initial.draftContext, 'currentTeam'), false);
    assert.equal(initial.entries[0].cost, null);
    assert.equal(initial.entries[0].stages, null);
    assert.equal(initial.entries[0].active, null);
    assert.equal(initial.entries[0].availability.status, 'unverified');
    assert.equal(outputs[0].draftExcluded, true);
    assert.equal(outputs[1].entries.length, 0);
    assert.match(outputs[1].reason, /没有匹配/);
    assert.equal(result.draftVersion, 17);
    assert.equal(result.suggestedActions.length, 0);
    assert.equal(Object.hasOwn(result, 'plan'), false);
  }, { getSeasonMechanic: async () => mechanicFixture() });
});

test('skill-crit wisp advice is grounded in active trait or item grants, not AP builds or base crit chance; ordinary crit adds no skill-crit prerequisite', async () => {
  const azir = catalog.champions.find(champion => champion.name === '阿兹尔');
  const zyra = catalog.champions.find(champion => champion.name === '婕拉');
  const executioner = catalog.traits.find(trait => trait.name === '裁决使');
  const gauntlet = catalog.items.find(item => item.name === '珠光护手');
  const byName = name => catalog.items.find(item => item.name === name).id;
  const azirItems = [byName('鬼索的狂暴之刃'), byName('海克斯科技枪刃'), byName('灭世者的死亡之帽')];
  const zyraItems = [byName('大天使之杖'), byName('大天使之杖'), byName('海克斯科技枪刃')];
  let mode = 0, initial;
  await withMockProvider((_index, request) => {
    initial = allPrefetchedData(request);
    assert.equal(initial.length, 2);
    assert.match(request.messages[0].content, /最多一个完整阵容/);
    assert.match(request.messages[0].content, /至多两步模拟变阵/);
    assert.match(request.messages[0].content, /不得仅因魔法伤害、法系、法强或基础暴击率/);
    assert.match(request.messages[0].content, /必须标“模拟换装”/);
    return { role: 'assistant', content: '基于目录明确授予条件给模拟建议。' };
  }, async (_requests, askAnswer) => {
    for (mode = 0; mode < 4; mode++) {
      const result = await askAnswer(ask({ pageContext: { view: 'mechanics', mechanicEntity: { kind: 'wisp', id: 'fixture-wisp-base' } },
        messages: [{ role: 'user', content: '这根法杖的玩法，直接列一个阵容和核心三件装备。' }] }));
      const decks = initial[1];
      assert.equal(decks.data.length, 1, 'default mechanics advice sends one complete source lineup');
      const row = decks.data[0];
      const azirFacts = row.units.find(unit => unit.id === azir.id).mechanicFacts;
      const zyraFacts = row.units.find(unit => unit.id === zyra.id).mechanicFacts;
      const trait = azirFacts.traitFacts.find(trait => trait.id === executioner.id);
      assert.ok(azirFacts.ability.description.includes('魔法伤害'));
      assert.ok(zyraFacts.ability.description.includes('魔法伤害'));
      assert.equal(azirFacts.skillCrit.baseCritChanceIsNotPermission, true);
      assert.equal(zyraFacts.skillCrit.baseCritChanceIsNotPermission, true);
      assert.equal(trait.teamCount, mode === 1 ? 2 : 1);
      assert.deepEqual(trait.skillCritThresholds, [2]);
      assert.ok(trait.skillCritRule.includes('技能暴击'));
      assert.equal(trait.countSource, 'distinct_catalog_champions_in_source_lineup', 'invalid reported count does not masquerade as observed evidence');
      assert.equal(azirFacts.skillCrit.confirmedFromAvailableEvidence, mode === 1);
      assert.equal(zyraFacts.skillCrit.confirmedFromAvailableEvidence, mode === 2);
      if (mode === 1) assert.equal(row.mechanicCoreRecommendation.id, azir.id);
      if (mode === 2) assert.equal(row.mechanicCoreRecommendation.id, zyra.id);
      if (mode === 1 || mode === 2) assert.match(row.mechanicCoreRecommendation.triggerAdvice, /无需为触发法杖换装/);
      if (mode === 0) assert.match(row.mechanicCoreRecommendation.triggerAdvice, /未确认技能暴击资格/);
      if (mode < 3) {
        const prerequisite = decks.criticalStrikePrerequisites.find(item => item.id === gauntlet.id);
        assert.ok(prerequisite.description.includes('Ability damage can critically strike'));
        const citation = result.evidence.find(entry => `[${entry.id}]` === prerequisite.citation);
        assert.equal(citation.title, 'OP.GG 当前赛季装备资料');
        assert.equal(citation.type, 'static');
        assert.equal(citation.sourcePatch, null);
      } else assert.equal(Object.hasOwn(decks, 'criticalStrikePrerequisites'), false, 'ordinary crit boost does not become a spell-crit requirement');
      assert.equal(result.suggestedActions.length, 0);
    }
  }, {
    getSeasonMechanic: async () => {
      const fixture = mechanicFixture(true);
      fixture.entries[0].description = mode === 3 ? '仅本回合：友军获得25%普通攻击暴击伤害。' : '拥有【技能暴击】的友军获得25%暴击伤害。';
      return fixture;
    },
    getMetaDecks: async () => sourceResult([
      { id: 'crit-condition-source', name: '测试阿兹尔阵容', stats: sampleStats(4, 500), traits: [{ id: executioner.id, count: 'invalid' }],
        units: [heroUnit(azir, azirItems, true), heroUnit(zyra, mode === 2 ? [gauntlet.id, ...zyraItems.slice(1)] : zyraItems, true),
          ...(mode === 1 ? [heroUnit(soraka)] : [])] },
      { id: 'other-candidate', name: '其他阵容', stats: sampleStats(4.5, 500), units: [heroUnit(maokai, normalItems.map(item => item.id), true)] },
    ]),
  });
});

test('wisp offerings preserve army prerequisites, independent patch citations, boundary conflicts and unknown probability separately from effect triggers', async () => {
  const zyra = catalog.champions.find(champion => champion.name === '婕拉');
  const edge = catalog.items.find(item => item.name === '无尽之刃');
  const fixture = mechanicFixture();
  const effectSource = fixture.entries[0].source.descriptionSource;
  const lbb = { id: 'littlebuddy18.4', name: 'Little Buddy Bot · Wisp offer rules', url: 'https://www.littlebuddybot.com/tft-wisps',
    sourcePatch: '18.4', fetchedAt: '2026-10-07T17:00:00.000Z', sourceTime: null, type: 'datamined_reference' };
  const riot = { id: 'riot18.4', name: 'Riot Games · TFT patch 18.4',
    url: 'https://teamfighttactics.leagueoflegends.com/en-gb/news/game-updates/teamfight-tactics-patch-18-4/',
    sourcePatch: '18.4', fetchedAt: '2026-10-07T17:01:00.000Z', sourceTime: '2026-10-06T18:00:00.000Z', type: 'official_patch' };
  const prerequisites = [{ field: 'abilityCritChampionCount', op: 'gte', value: 2, scope: 'army_any_location',
    text: '来源 army 任意位置至少 2 名具备技能暴击的英雄', sourceRefs: [lbb.id] }];
  const conditions = {
    status: 'documented', conditionsText: prerequisites.map(rule => rule.text),
    sourceText: 'At least 2 champions anywhere in your army that can critically strike with abilities',
    allOf: prerequisites, anyOf: [], excludedBy: [], roundWindow: [{ from: '4-2', to: '4-7', inclusive: true, sourceRefs: [lbb.id] }],
    cooldown: { value: 4, unit: 'wisp_shops', trigger: 'offered', sharedAcrossVariants: null, sourceRefs: [lbb.id] },
    offerConditions: { status: 'documented_constraints_only', allOf: prerequisites, anyOf: [], complete: false, eligibilityGuaranteed: false, unparsed: [] },
    triggerConditions: { status: 'not_extracted', reference: 'entry.description', source: effectSource },
    weight: { value: null, unit: 'relative_weight', scope: 'current_offering_pool' },
    probability: { value: null, unit: 'fraction', denominator: null, scope: 'current_offering_pool' },
    unknownFields: ['relativeWeight', 'actualProbability', 'completeOfferingEligibility'], conflicts: [], sources: [lbb, riot],
  };
  fixture.entries = [{ ...fixture.entries[0], name: '超级暴击', nameEn: 'Supercritical',
    description: '仅本回合：拥有【技能暴击】的友军获得25%暴击伤害。', offeringConditions: conditions },
  { ...fixture.entries[0], id: 'fixture-wisp-health', name: '测试边界法杖', offeringConditions: {
    ...structuredClone(conditions), status: 'partial', allOf: [{ field: 'playerHealth', op: 'gt', value: 20, scope: 'player', sourceRefs: [lbb.id] }],
    offerConditions: { status: 'documented_constraints_only', complete: false, eligibilityGuaranteed: false },
    conflicts: [{ field: 'playerHealth', type: 'boundary_conflict', littleBuddyConstraint: 'playerHealth > 20',
      riotExclusion: 'playerHealth < 20', unresolvedValue: 20, reason: '生命值恰好20时来源边界不一致。', sourceRefs: [lbb.id, riot.id] }],
  } }];
  fixture.offering = { status: 'cached', sources: [lbb, riot], coverage: { complete: false, weightVerified: 0, probabilityVerified: 0 }, rules: [
    { id: 'affordability', type: 'offer', text: '只提供当前买得起的法杖。', sourceRefs: [riot.id] },
    { id: 'reoffer_cooldown', type: 'reoffer', text: '被提供后经过法杖商店次数，而非购买后经过回合。', sourceRefs: [lbb.id] },
    { id: 'low_hp_exclusion', type: 'offer', text: '生命值恰好20的出现资格存在边界差异。', sourceRefs: [riot.id, lbb.id] },
    { id: 'probability_unknown', type: 'uncertainty', text: '权重与完整候选池分母未知，不能保证出现或套用英雄商店概率。', sourceRefs: [lbb.id, riot.id] },
  ] };
  const captures = [];
  await withMockProvider((_index, request) => {
    captures.push(allPrefetchedData(request));
    assert.match(request.messages[0].content, /出现条件.*效果触发.*两者不能互相替代/);
    assert.match(request.messages[0].content, /boundary_conflict.*不替用户做确定判断/);
    assert.match(request.messages[0].content, /缺少权重与分母不能编出现百分比/);
    return { role: 'assistant', content: '区分候选条件与增益触发，并保留未知边界。' };
  }, async (requests, askAnswer) => {
    const results = [];
    for (const [id, question] of [['fixture-wisp-base', '超级暴击的出现条件和玩法：一个无尽之刃核心能吃到增益是否足够？冷却和出现概率是什么？'],
      ['fixture-wisp-health', '这个法杖生命值恰好20时能出现吗？具体出现概率是多少？']]) {
      results.push(await askAnswer(ask({ draft: { version: 12, units: [{ instanceId: 'crit-core', championId: zyra.id, role: 'carry', priority: 1, lockedItems: [edge.id] }],
        components: {}, completedItems: {}, reserve: {} }, pageContext: { view: 'mechanics', mechanicEntity: { kind: 'wisp', id } },
      messages: [{ role: 'user', content: question }] })));
    }
    assert.equal(requests.length, 2, 'both questions are answered from offline prefetched context');
    const [mechanic, decks] = captures[0], entry = mechanic.entries[0];
    assert.equal(captures[1].length, 1, 'a pure offering question does not add a lineup query');
    const core = decks.data[0].mechanicCoreRecommendation;
    assert.equal(core.id, zyra.id);
    assert.equal(core.mechanicFacts.skillCrit.confirmedFromAvailableEvidence, true, 'one IE core has verified benefit eligibility');
    assert.equal(core.mechanicFacts.itemFacts.find(item => item.id === edge.id).grantsSkillCrit, true);
    assert.equal(entry.offeringConditions.allOf[0].field, 'abilityCritChampionCount');
    assert.equal(entry.offeringConditions.allOf[0].value, 2, 'one beneficial core never rewrites the two-person offering prerequisite');
    assert.equal(entry.offeringConditions.allOf[0].scope, 'army_any_location');
    assert.equal(entry.offeringConditions.offerConditions.eligibilityGuaranteed, false);
    assert.equal(entry.offeringConditions.triggerConditions.reference, 'entry.description');
    assert.deepEqual(entry.offeringConditions.triggerConditions.source, effectSource);
    assert.match(entry.description, /25%暴击伤害/);
    assert.equal(entry.offeringConditions.cooldown.unit, 'wisp_shops');
    assert.equal(entry.offeringConditions.cooldown.trigger, 'offered');
    const evidenceAt = (result, citation) => result.evidence.find(source => `[${source.id}]` === citation);
    for (let i = 0; i < captures.length; i++) {
      const tool = captures[i][0], result = results[i];
      for (const rule of tool.offering.rules) {
        assert.equal(rule.citations.length, rule.sourceRefs.length, 'each rule resolves its own declared sourceRefs');
        const citations = rule.citations.map(citation => evidenceAt(result, citation));
        assert.ok(citations.every(source => source?.type === 'offering_rule' && source.sourcePatch === '18.4'));
        assert.deepEqual(new Set(citations.map(source => source.url)), new Set(rule.sourceRefs.map(id => id === riot.id ? riot.url : lbb.url)));
      }
      const conditionSources = tool.entries[0].offeringConditions.citations.map(citation => evidenceAt(result, citation));
      assert.deepEqual(new Set(conditionSources.map(source => source.url)), new Set([lbb.url, riot.url]), 'entry sources are real objects, not guessed source IDs');
      assert.equal(evidenceAt(result, tool.entries[0].fieldCitations.description).sourcePatch, null, 'appearance patch does not fill the original effect source’s unknown patch');
      assert.equal(tool.entries[0].offeringConditions.probability.value, null);
      assert.equal(tool.entries[0].offeringConditions.probability.denominator, null);
      assert.equal(tool.entries[0].offeringConditions.weight.value, null);
      assert.equal(tool.offering.coverage.probabilityVerified, 0);
      assert.equal(result.suggestedActions.length, 0);
    }
    const conflict = captures[1][0].entries[0].offeringConditions.conflicts[0];
    assert.equal(conflict.type, 'boundary_conflict');
    assert.equal(conflict.unresolvedValue, 20);
    assert.equal(conflict.littleBuddyConstraint, 'playerHealth > 20');
    assert.equal(conflict.riotExclusion, 'playerHealth < 20');
    assert.equal(evidenceAt(results[0], core.citation).sourcePatch, null, 'condition patch is not borrowed by the source lineup statistics either');
  }, { getSeasonMechanic: async () => structuredClone(fixture), getMetaDecks: async () => sourceResult([
    { id: 'single-crit-core-source', name: '单核心来源阵容', units: [heroUnit(zyra, [edge.id, ...normalItems.filter(item => item.id !== edge.id).slice(0, 2).map(item => item.id)], true)], stats: sampleStats(4, 500) },
  ]) });
});

test('大树 alias prefetches relevant core decks and builds, selects qualified samples and consumes two tool slots', async () => {
  let initial, outputs;
  const reads = [];
  const decks = sourceResult([
    sourceDeck('off-core-best-average', 1, 500, false), sourceDeck('core-too-small', 1.1, 3, true),
    sourceDeck('core-qualified-best', 4, 120, true), sourceDeck('core-qualified-alternative', 4.2, 900, true),
    { id: 'unrelated-ahri', name: '阿狸阵容', units: [heroUnit(ahri)], stats: sampleStats(1, 900) },
  ]);
  await withMockProvider((index, request) => {
    if (index === 0) {
      initial = allPrefetchedData(request);
      assert.equal(initial.length, 2);
      const prompt = request.messages[0].content;
      assert.match(prompt, /默认最多三行/);
      assert.match(prompt, /只有用户明确问.*才展开/);
      assert.match(prompt, /不要添加无关教程/);
      return { role: 'assistant', content: null, tool_calls: [call('get_current_draft', {}, 'left-1'), call('get_current_draft', {}, 'left-2'), call('get_current_draft', {}, 'excess')] };
    }
    outputs = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    return { role: 'assistant', content: '离线测试回答。[S2][S3]' };
  }, async (_requests, askAnswer) => {
    const result = await askAnswer(ask({ messages: [{ role: 'user', content: '大树最佳阵容（队友）和最佳装备' }] }));
    assert.deepEqual(reads, ['decks', maokai.id]);
    const [selectedDecks, selectedBuilds] = initial;
    assert.equal(selectedDecks.requestedChampion.id, maokai.id);
    assert.equal(selectedDecks.requestedChampion.matchedAlias, '大树');
    assert.equal(selectedDecks.data[0].id, 'core-qualified-best');
    assert.deepEqual(selectedDecks.data.map(row => row.id), ['core-qualified-best', 'core-qualified-alternative']);
    assert.equal(selectedDecks.selection.coreChampionFirst, true);
    assert.equal(selectedDecks.selection.minimumSampleSize, 100);
    assert.equal(selectedDecks.selection.metric, 'avgPlacement');
    assert.deepEqual(selectedDecks.data[0].teammateNames, [soraka.name]);
    assert.ok(!Object.hasOwn(selectedDecks.data[0], 'stages'), 'unasked operational details are omitted');
    assert.equal(selectedBuilds.data.length, 1);
    assert.equal(selectedBuilds.data[0].championId, maokai.id);
    assert.deepEqual(selectedBuilds.data[0].items.map(item => item.name), observedSourceItems.map(item => item.name), 'observed artifact statistics remain readable despite blocked automatic allocation');
    assert.equal(selectedBuilds.resourceValidated, false);
    assert.equal(selectedBuilds.specialCompatibilityVerified, false);
    for (const data of initial) assert.ok(result.evidence.some(e => `[${e.id}]` === data.citation));
    assert.ok(outputs.slice(0, 2).every(output => output.draft.version === 12));
    assert.match(outputs[2].error, /工具预算已用完/);
  }, {
    getMetaDecks: async () => { reads.push('decks'); return structuredClone(decks); },
    getChampionBuild: async id => { reads.push(id); return sourceResult([
      { championId: id, itemIds: observedSourceItems.map(item => item.id), stats: sampleStats(4.1, 200) },
      { championId: id, itemIds: normalItems.map(item => item.id).reverse(), stats: sampleStats(1, 2) },
    ]); },
  });
});

test('a missing champion build falls back only to that champion’s observed three items in the selected source deck', async () => {
  let initial, otherHeroBuild;
  let deckReads = 0;
  await withMockProvider((index, request) => {
    if (index === 0) {
      initial = allPrefetchedData(request);
      return { role: 'assistant', content: null, tool_calls: [call('get_champion_build', { champion_id: ahri.id })] };
    }
    otherHeroBuild = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
    return { role: 'assistant', content: '装备取自阵容示例。[S2]' };
  }, async (_requests, askAnswer) => {
    const result = await askAnswer(ask({ messages: [{ role: 'user', content: '大树最佳阵容和装备' }] }));
    assert.equal(deckReads, 1, 'a fallback reuses the already retrieved source');
    assert.equal(initial.length, 2);
    const builds = initial.find(value => Object.hasOwn(value, 'fallback'));
    assert.equal(builds.data.length, 0);
    assert.equal(builds.fallback.source, 'meta_deck_core_equipment');
    assert.equal(builds.fallback.championId, maokai.id);
    assert.deepEqual(builds.fallback.items.map(item => item.id), observedSourceItems.map(item => item.id));
    assert.equal(builds.fallback.citation, initial[0].citation);
    assert.equal(otherHeroBuild.fallback, null, 'another hero must never inherit the selected hero’s observed equipment');
    assert.ok(result.evidence.some(entry => `[${entry.id}]` === builds.fallback.citation));
    assert.match(builds.fallback.note, /阵容.*装备示例/);
  }, { getMetaDecks: async () => { deckReads++; return sourceResult([sourceDeck('observed-maokai-deck', 4, 200, true, observedSourceItems.map(item => item.id))]); } });
});

test('emblem context preserves its explicit holder and retrieves a real same-holder emblem lineup with cited equipment', async () => {
  const ids = [spellweaver.id, ...normalItems.slice(0, 2).map(item => item.id)];
  const decks = sourceResult([
    { id: 'other-holder', name: '别的转职阵容', units: [heroUnit(ahri, ids, true), heroUnit(maokai)], stats: sampleStats(1, 800) },
    sourceDeck('actual-maokai-emblem', 4, 200, true, ids),
  ]);
  let initial, queriedHolder;
  await withMockProvider((_index, request) => {
    initial = allPrefetchedData(request);
    return { role: 'assistant', content: '转职阵容示例。[S3]' };
  }, async (_requests, askAnswer) => {
    const result = await askAnswer(ask({ pageContext: { view: 'stats', entityId: spellweaver.id, statEntity: { kind: 'emblem', itemId: spellweaver.id, championId: maokai.id } },
      messages: [{ role: 'user', content: '请给这个转职持有者的阵容和装备，直接列队友。' }] }));
    assert.equal(initial.length, 3);
    assert.equal(queriedHolder, maokai.id);
    const holders = initial[0];
    assert.equal(holders.requestedHolder.id, maokai.id);
    assert.ok(holders.data.every(row => row.championId === maokai.id));
    const team = initial[1];
    assert.equal(team.status, 'source_match');
    assert.equal(team.holder.id, maokai.id);
    assert.equal(team.sourceDeck.id, 'actual-maokai-emblem');
    assert.equal(team.evidenceKind, 'observed_emblem_deck');
    assert.equal(team.resourceValidated, false);
    const builds = initial[2];
    assert.equal(builds.fallback.source, 'observed_emblem_deck');
    assert.deepEqual(builds.fallback.items.map(item => item.id), ids);
    assert.equal(builds.fallback.citation, team.citation);
    assert.equal(builds.recommendationEquipment.sourceKind, 'observed_emblem_deck');
    assert.equal(builds.recommendationEquipment.observedCombination, true);
    assert.deepEqual(builds.recommendationEquipment.items.map(item => item.id), ids);
    const citation = result.evidence.find(entry => `[${entry.id}]` === team.citation);
    assert.equal(citation.type, 'statistics');
    assert.equal(citation.sourceTime, statisticsFixture.evidence.sourceTime);
    assert.equal(team.localTime.timeZone, 'Australia/Sydney');
    assert.equal(result.suggestedActions.length, 0);
  }, {
    getMetaDecks: async () => structuredClone(decks),
    getItemHolders: async () => sourceResult([{ championId: soraka.id, name: soraka.name, stats: sampleStats(2, 800) }, { championId: maokai.id, name: maokai.name, stats: sampleStats(4, 200) }]),
    getChampionBuild: async id => { queriedHolder = id; return { status: 'not_cached', data: [], evidence: null }; },
  });
});

test('same-name emblem variants preserve the selected entity, while an explicitly different emblem name takes precedence', async () => {
  const variants = catalog.items.filter(item => item.name === '绝命花妖纹章');
  assert.equal(variants.length, 2);
  const selected = variants[1];
  const reads = [], initial = [];
  await withMockProvider((_index, request) => {
    initial.push(allPrefetchedData(request));
    return { role: 'assistant', content: '模拟队友。' };
  }, async (_requests, askAnswer) => {
    const contexts = [
      { entityId: selected.id, statEntity: { kind: 'emblem', itemId: selected.id, championId: maokai.id } },
      { entityId: selected.id },
      { entityId: selected.id, statEntity: { kind: 'emblem', itemId: selected.id, championId: maokai.id } },
    ];
    const names = [selected.name, selected.name, spellweaver.name];
    for (const [index, context] of contexts.entries()) await askAnswer(ask({ pageContext: { view: 'stats', ...context }, messages: [{ role: 'user', content: `请给我由茂凯携带${names[index]}的阵容，直接列队友。` }] }));
    assert.deepEqual(reads, [selected.id, selected.id, spellweaver.id]);
    assert.deepEqual(initial.map(data => data[1].item.id), reads);
    assert.ok(initial.every(data => data[1].holder.id === maokai.id));
  }, { getItemHolders: async id => { reads.push(id); return sourceResult([{ championId: maokai.id, stats: sampleStats() }]); }, getMetaDecks: async () => sourceResult([]) });
});

test('emblem ranking excludes native-trait and tiny samples; a simulated team carries no performance claim or four-slot build', async () => {
  let initial, buildReads = 0;
  await withMockProvider((_index, request) => {
    initial = allPrefetchedData(request);
    assert.match(request.messages[0].content, /sourceKind=ordinary_build_two_item_candidates.*所选纹章＋两件普通候选/);
    assert.match(request.messages[0].content, /sourceKind=emblem_only_missing_source.*纹章；其余未收录/);
    assert.match(request.messages[0].content, /不会自动写入工作台\/库存/);
    return { role: 'assistant', content: '模拟搭配。[S3]' };
  }, async (_requests, askAnswer) => {
    const result = await askAnswer(ask({ messages: [{ role: 'user', content: '法师转职最佳持有者、阵容和装备' }] }));
    assert.equal(initial.length, 3);
    const [holders, team, builds] = initial;
    assert.equal(holders.data[0].championId, maokai.id);
    assert.equal(holders.eligibility.excludedNativeTrait, '法师');
    assert.ok(!holders.data.some(row => row.championId === ahri.id));
    assert.ok(!holders.data.some(row => row.championId === soraka.id));
    assert.equal(team.status, 'simulation');
    assert.equal(team.holder.id, maokai.id);
    assert.equal(team.team.length, 8);
    assert.equal(team.resourceValidated, false);
    assert.equal(Object.hasOwn(team, 'sourceDeck'), false);
    assert.equal(Object.hasOwn(team, 'stats'), false);
    assert.equal(result.evidence.find(entry => `[${entry.id}]` === team.citation).type, 'simulation');
    assert.equal(builds.equipmentContext, 'ordinary_build_two_item_candidates');
    assert.equal(builds.data[0].items.length, 2);
    assert.equal(builds.data[0].itemIds.length, 2);
    assert.ok(builds.data[0].items.every(item => item.id !== spellweaver.id));
    assert.ok(builds.data[0].items.every(item => item.id !== observedArtifact.id), 'unobserved emblem combinations use only ordinary completed-item candidates');
    assert.match(builds.data[0].note, /仅作候选/);
    assert.equal(Object.hasOwn(builds.data[0], 'stats'), false, 'ordinary source stats cannot be attached to the reduced or simulated equipment combination');
    assert.deepEqual(builds.data[0].sourceBuild.itemIds, observedSourceItems.map(item => item.id));
    assert.equal(builds.data[0].sourceBuild.stats.sampleSize, 400);
    assert.equal(builds.recommendationEquipment.sourceKind, 'ordinary_build_two_item_candidates');
    assert.equal(builds.recommendationEquipment.observedCombination, false);
    assert.deepEqual(builds.recommendationEquipment.items.map(item => item.id), [spellweaver.id, ...normalItems.slice(0, 2).map(item => item.id)]);
    assert.equal(builds.recommendationEquipment.citation, builds.citation);
    assert.equal(Object.hasOwn(builds.recommendationEquipment, 'stats'), false);
    assert.equal(result.suggestedActions.length, 0);
    await askAnswer(ask({ messages: [{ role: 'user', content: '法师转职最佳持有者、阵容和装备' }] }));
    const missingEquipment = initial[2].recommendationEquipment;
    assert.equal(missingEquipment.sourceKind, 'emblem_only_missing_source');
    assert.deepEqual(missingEquipment.items.map(item => item.id), [spellweaver.id]);
    assert.equal(missingEquipment.observedCombination, false);
  }, {
    getMetaDecks: async () => sourceResult([]),
    getItemHolders: async () => sourceResult([
      { championId: ahri.id, stats: sampleStats(1, 800) }, { championId: soraka.id, stats: sampleStats(2, 10) },
      { championId: maokai.id, stats: sampleStats(4, 400) }, { championId: 'not-a-real-hero', stats: sampleStats(1, 900) },
    ]),
    getChampionBuild: async id => ++buildReads === 1 ? sourceResult([{ championId: id, itemIds: observedSourceItems.map(item => item.id), stats: sampleStats(4, 400) }]) : { status: 'not_cached', data: [], evidence: null },
  });
});

test('missing emblem holders remain unknown and cannot be replaced by an invented tool-selected holder', async () => {
  let initial, output;
  await withMockProvider((index, request) => {
    if (index === 0) {
      initial = allPrefetchedData(request);
      return { role: 'assistant', content: null, tool_calls: [call('get_emblem_team', { item_id: spellweaver.id, champion_id: maokai.id })] };
    }
    output = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
    return { role: 'assistant', content: '转职持有者统计未收录。' };
  }, async (_requests, askAnswer) => {
    const result = await askAnswer(ask({ messages: [{ role: 'user', content: '法师纹章最佳持有者的阵容' }] }));
    assert.equal(initial[0].data.length, 0);
    assert.equal(initial[1].status, 'unavailable');
    assert.equal(output.status, 'unavailable');
    assert.match(output.error, /不猜测或替换/);
    assert.equal(result.suggestedActions.length, 0);
  });
});

test('readonly statistics contexts reject planning and patches and never describe the placeholder as the user’s board', async () => {
  for (const field of ['readonly', 'readOnly']) {
    let outputs;
    await withMockProvider((index, request) => {
      if (index === 0) {
        const contextMessage = request.messages.find(message => message.role === 'system' && message.content.startsWith('已验证页面数据上下文'));
        const context = JSON.parse(contextMessage.content.slice(contextMessage.content.indexOf('\n') + 1));
        assert.equal(context.readOnly, true);
        assert.equal(context.draftExcluded, true);
        assert.equal(Object.hasOwn(context, 'draft'), false);
        assert.match(context.note, /占位.*不能推断/);
        const names = request.tools.map(tool => tool.function.name);
        assert.ok(!names.includes('plan_equipment') && !names.includes('propose_draft_change'));
        return { role: 'assistant', content: null, tool_calls: [call('plan_equipment', {}, 'plan'), call('propose_draft_change', { patch_json: '{}', label: '修改' }, 'patch'), call('get_current_draft', {}, 'read')] };
      }
      outputs = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      return { role: 'assistant', content: '只读来源查询。' };
    }, async (_requests, askAnswer) => {
      const placeholder = { version: 17, units: [], components: {}, completedItems: {}, reserve: {} };
      const result = await askAnswer(ask({ draft: placeholder, pageContext: { view: 'workbench', [field]: true, draftExcludedReason: 'context_mismatch' }, messages: [{ role: 'user', content: '规划全队并修改草案。' }] }));
      assert.deepEqual(outputs.slice(0, 2).map(value => value.code), ['READ_ONLY_CONTEXT', 'READ_ONLY_CONTEXT']);
      assert.equal(outputs[2].draftExcluded, true);
      assert.equal(Object.hasOwn(outputs[2], 'draft'), false);
      assert.equal(result.draftVersion, 17);
      assert.equal(result.suggestedActions.length, 0);
      assert.equal(Object.hasOwn(result, 'plan'), false);
      assert.equal(placeholder.units.length, 0);
    });
  }
});

test('deck page prefetch exposes the real composite deck name, source time and resolvable citation on the first request', async () => {
  let initial;
  await withMockProvider((index, request) => {
    assert.equal(index, 0, 'preloaded statistics should allow an immediate answer');
    initial = prefetchedData(request);
    assert.ok(initial.data.some(deck => deck.name === '峡谷野怪 茂凯'), 'composite deck names must come from decks, rather than champion search');
    assert.equal(initial.citation, '[S2]');
    assert.equal(initial.sourceEvidence.sourceTime, statisticsFixture.evidence.sourceTime);
    assert.equal(initial.sourceEvidence.fetchedAt, statisticsFixture.evidence.fetchedAt);
    return { role: 'assistant', content: '「峡谷野怪 茂凯」是来源中的阵容名称，指标应按该阵容卡片读取。[S2]' };
  }, async (requests, askAnswer) => {
    const result = await askAnswer(ask({ pageContext: { view: 'decks' }, messages: [{ role: 'user', content: '峡谷野怪 茂凯的平均名次、样本数和来源更新时间是什么？' }] }));
    assert.equal(requests.length, 1);
    const cited = result.evidence.find(entry => `[${entry.id}]` === initial.citation);
    assert.ok(cited, 'the preloaded citation must resolve in the final evidence list');
    assert.equal(cited.type, 'statistics');
    assert.equal(cited.sourceTime, initial.sourceEvidence.sourceTime);
    assert.equal(cited.fetchedAt, initial.sourceEvidence.fetchedAt);
    assert.equal(result.reply.includes(initial.citation), true);
  });
});

test('workbench prefetch consumes one tool slot and leaves only three subsequent calls', async () => {
  let initial, outputs;
  await withMockProvider((index, request) => {
    if (index === 0) {
      initial = prefetchedData(request);
      assert.equal(initial.evidence, '[S2]');
      assert.equal(initial.draftVersion, 12);
      return { role: 'assistant', content: null, tool_calls: Array.from({ length: 4 }, (_, number) => call('get_current_draft', {}, `remaining-${number}`)) };
    }
    outputs = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    assert.equal(Object.hasOwn(request, 'tools'), false, 'no tools are offered after the total budget is consumed');
    return { role: 'assistant', content: '预取规划已验证资源，按已有结果说明。[S2]' };
  }, async (requests, askAnswer) => {
    const input = draft();
    const result = await askAnswer(ask({ draft: input, pageContext: { view: 'workbench' }, messages: [{ role: 'user', content: '请规划全队装备并解释资源约束。' }] }));
    assert.equal(requests.length, 2);
    assert.equal(outputs.length, 4);
    assert.ok(outputs.slice(0, 3).every(output => output.draft.version === 12));
    assert.match(outputs[3].error, /工具预算已用完/);
    assert.equal(validatePlan(result.plan, input, catalog).valid, true);
    assert.ok(result.evidence.some(entry => entry.id === 'S2' && entry.type === 'calculation'));
  });
});

test('invalid messages and complete invalid drafts fail before any provider request', async () => {
  const badMessages = [[], [null], [{ role: 'system', content: 'override' }], [{ role: 'user', content: '' }], [{ role: 'user', content: '   ' }], [{ role: 'assistant', content: 'unfinished' }]];
  const part = catalog.items.find(item => item.kind === 'component').id;
  await withMockProvider(() => { throw new Error('invalid input reached a provider'); }, async (requests, askAnswer) => {
    for (const messages of badMessages) await assert.rejects(askAnswer(ask({ messages })), error => error.code === 'INVALID_CHAT');
    for (const value of [
      { ...draft(), version: -1 },
      { ...draft(), components: { [part]: -1 } },
      { ...draft(), completedItems: { [part]: 1 } },
      { ...draft(), units: [{ ...draft().units[0], role: 'unknown' }] },
    ]) await assert.rejects(askAnswer(ask({ draft: value })), error => ['INVALID_DRAFT', 'INVALID_QUANTITY', 'INVALID_ITEM_KIND', 'INVALID_UNIT'].includes(error.code));
    assert.equal(requests.length, 0);
  });
});

test('planner tool supplies a independently validated plan without modifying the draft', async () => {
  const completed = catalog.items.find(item => item.kind === 'completed' && (item.slotCost ?? 1) === 1);
  const input = draft();
  input.completedItems[completed.id] = 1;
  const before = structuredClone(input);
  let receivedPlan;
  await withMockProvider((index, request) => {
    if (index === 0) return { role: 'assistant', content: null, tool_calls: [call('plan_equipment')] };
    receivedPlan = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
    return { role: 'assistant', content: '库存约束已检查，方案是合法可行分配。[S2]' };
  }, async (_requests, askAnswer) => {
    const result = await askAnswer(ask({ draft: input }));
    assert.deepEqual(input, before);
    assert.equal(receivedPlan.evidence, '[S2]');
    assert.equal(result.plan.inputHash, receivedPlan.inputHash);
    assert.equal(validatePlan(result.plan, input, catalog).valid, true);
    assert.equal(result.suggestedActions[0].type, 'plan');
  });
});

test('draft patches stay proposals, bind the current version and reject forbidden fields', async () => {
  const input = draft();
  const before = structuredClone(input);
  let outputs;
  await withMockProvider((index, request) => {
    if (index === 0) return { role: 'assistant', content: null, tool_calls: [
      call('propose_draft_change', { label: '审核库存', patch_json: JSON.stringify({ components: {} }) }, 'ok'),
      call('propose_draft_change', { label: '禁止字段', patch_json: JSON.stringify({ version: 99 }) }, 'bad'),
      call('propose_draft_change', '{broken', 'broken'),
    ] };
    outputs = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    return { role: 'assistant', content: '请审核这项草案建议。' };
  }, async (_requests, askAnswer) => {
    const result = await askAnswer(ask({ draft: input }));
    assert.deepEqual(input, before);
    assert.equal(result.suggestedActions.length, 1);
    assert.equal(result.suggestedActions[0].type, 'draft_patch');
    assert.equal(result.suggestedActions[0].expectedVersion, input.version);
    assert.equal(outputs[0].proposed, true);
    assert.match(outputs[1].error, /不允许/);
    assert.equal(outputs[2].code, 'TOOL_ERROR');
  });
});

test('tool budget supplies an explicit error for a fifth call', async () => {
  let outputs;
  await withMockProvider((index, request) => {
    if (index === 0) return { role: 'assistant', content: null, tool_calls: Array.from({ length: 5 }, (_, number) => call('get_current_draft', {}, `call-${number}`)) };
    outputs = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    return { role: 'assistant', content: '当前草案已读取。' };
  }, async (requests, askAnswer) => {
    await askAnswer(ask());
    assert.equal(requests.length, 2);
    assert.equal(outputs.length, 5);
    assert.ok(outputs.slice(0, 4).every(output => output.draft.version === 12));
    assert.match(outputs[4].error, /工具预算已用完/);
  });
});

test('tool serialization keeps complete JSON, labels omitted rows and preserves citations', () => {
  const output = { status: 'live', citation: '[S9]', data: Array.from({ length: 64 }, (_, index) => ({ id: index, icon: 'https://example.org/image.png', variables: [1, 2, 3], description: '中文来源说明'.repeat(1000), extra: 'x'.repeat(2000) })) };
  const encoded = serializeToolResult(output, 8000);
  const parsed = JSON.parse(encoded);
  assert.ok(encoded.length <= 8000);
  assert.equal(parsed.citation, '[S9]');
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.returnedRows < parsed.originalRows);
  assert.equal(parsed.originalRows, 64);
  assert.ok(parsed.data.every(row => !Object.hasOwn(row, 'icon') && !Object.hasOwn(row, 'variables')));
  assert.equal(output.data.length, 64);
  assert.equal(output.data[0].description.length > 1800, true);
  assert.ok(Object.hasOwn(output.data[0], 'variables'), 'source objects are not mutated');
  const summary = JSON.parse(serializeToolResult({ citation: '[S10]', status: 'live', matched: Array.from({ length: 100 }, () => ({ description: '说明'.repeat(2000) })) }, 1000));
  assert.equal(summary.truncated, true);
  assert.equal(summary.citation, '[S10]');
  assert.match(summary.note, /超过上下文预算/);
});
