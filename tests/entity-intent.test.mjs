import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildExplorerIndex, getEntityAliases, matchEntityMentions, searchCatalogEntities, searchExplorerEntities } from '../public/explorer-search.js';
import { namedBuildItems } from '../server/build-intent.mjs';
import { resolveResearchIntent } from '../server/research-intent.mjs';
import { debugChatRetrieval, answerChat } from '../server/chat.mjs';
import { getRiotResearchResults } from '../server/riot/query.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const index = buildExplorerIndex(catalog);
const hero = name => catalog.champions.find(row => row.name === name);
const item = name => catalog.items.find(row => row.name === name);
const nidalee = hero('奈德丽'), amumu = hero('阿木木');
const question = '豹女和木木同时上场，豹女带饮血，查最佳三件套及样本量。';
const expected = [{ type: 'champion', id: nidalee.id }, { type: 'champion', id: amumu.id }, { type: 'item', id: item('饮血剑').id, holderId: nidalee.id }];
const deps = {
  getCatalog: async () => catalog,
  getLibrarySnapshot: async () => ({ documents: [], augmentRules: [] }),
  getSeasonMechanic: async () => ({ entries: [] }),
  getMetaDecks: async () => { throw Error('Do not replace joint queries with lineups'); },
  getChampionBuild: async () => { throw Error('Do not replace joint queries with marginal hero statistics'); },
  searchKnowledge: async () => { throw Error('This statistical question is not RAG'); },
};
const emptyJoint = query => ({ query, status: 'empty', equipment: { rows: [] }, teammates: { rows: [] }, comps: { rows: [] }, coverage: { jointMatchQueries: true, matchedParticipants: 0 } });

test('the same catalog aliases identify nickname heroes and items in frontend and a multi-token tool query', () => {
  for (const [text, type, id] of [['豹女', 'champion', nidalee.id], ['木木', 'champion', amumu.id], ['板甲', 'item', item('石像鬼石板甲').id]]) {
    assert.equal(searchExplorerEntities(index, text, type)[0].entity.id, id);
    assert.equal(matchEntityMentions(index, text, type)[0].candidates[0].entity.id, id);
  }
  const results = searchCatalogEntities(index, '豹女 木木 饮血').map(row => row.entity.id);
  assert.ok([nidalee.id, amumu.id, item('饮血剑').id].every(id => results.includes(id)));
  assert.ok(!results.includes(item('光明版饮血剑').id));
  assert.deepEqual(searchCatalogEntities(buildExplorerIndex({ champions: [] }), '豹女'), []);
});

test('radiant and ordinary names stay separate, and emblem nicknames attach only to actual emblem rows', () => {
  const ordinary = item('石像鬼石板甲'), radiant = item('光明版石像鬼石板甲');
  assert.deepEqual(namedBuildItems('板甲', catalog).map(row => row.item.id), [ordinary.id]);
  assert.deepEqual(namedBuildItems('光明板甲', catalog).map(row => row.item.id), [radiant.id]);
  assert.deepEqual(namedBuildItems('光明板甲', { items: [ordinary] }), []);
  const emblem = catalog.items.find(row => row.category === 'emblem' && /纹章$/.test(row.name));
  const nickname = emblem.name.replace(/纹章$/, '转职');
  assert.ok(getEntityAliases(emblem, 'item').includes(nickname));
  assert.ok(searchExplorerEntities(index, nickname, 'item').some(row => row.entity.id === emblem.id));
  assert.ok(!getEntityAliases(ordinary, 'item').some(alias => alias.endsWith('转职')));
});

test('longest exact mentions suppress shorter names, while same-name variants stay ambiguous', () => {
  const fixture = buildExplorerIndex({ champions: [hero('茂凯'), { id: 'short-tree', name: '树' }, { id: 'lux-a', name: '拉克丝' }, { id: 'lux-b', name: '拉克丝' }] });
  const tree = matchEntityMentions(fixture, '大树的装备');
  assert.equal(tree.length, 1); assert.equal(tree[0].candidates[0].entity.id, hero('茂凯').id);
  const ambiguous = matchEntityMentions(fixture, '拉克丝的出装');
  assert.equal(ambiguous[0].ambiguous, true); assert.equal(ambiguous[0].candidates.length, 2);
  assert.equal(resolveResearchIntent('拉克丝和大树同时上场，拉克丝最佳装备', { champions: fixture.entries.map(row => row.entity), items: [] }), null);
});

test('nickname joint question preserves both heroes, worn item and target; blue buff does not add a jungle unit', () => {
  const resolved = resolveResearchIntent(question, catalog);
  assert.deepEqual(resolved.conditions, expected); assert.equal(resolved.carrierId, nidalee.id);
  const blue = resolveResearchIntent(question.replace('饮血', '蓝buff'), catalog);
  assert.deepEqual(blue.conditions, [...expected.slice(0, 2), { type: 'item', id: item('蓝霸符').id, holderId: nidalee.id }]);
  const radiant = resolveResearchIntent(question.replace('饮血', '光明板甲'), catalog);
  assert.equal(radiant.conditions.at(-1).id, item('光明版石像鬼石板甲').id);
  assert.equal(resolveResearchIntent(question.replace('饮血', '目录不存在的装备'), catalog), null);
});

test('each explicitly worn item stays on its own holder when a different hero is the requested build target', () => {
  const result = resolveResearchIntent('豹女和木木同时上场，豹女带饮血，木木带板甲，查豹女最佳三件套', catalog);
  assert.equal(result.carrierId, nidalee.id);
  assert.deepEqual(result.conditions.filter(row => row.type === 'item'), [expected[2], { type: 'item', id: item('石像鬼石板甲').id, holderId: amumu.id }]);
});

test('the actual failed question prefetches one joint query even when the open page contains older conditions', async () => {
  let queries = 0;
  const preview = await debugChatRetrieval({ question, pageContext: { view: 'explorer', research: { conditions: expected.slice(0, 2), carrierId: amumu.id, minSample: 100 } } }, { ...deps,
    getResearchResults: async query => { queries++; assert.deepEqual(query.conditions, expected); assert.equal(query.carrierId, nidalee.id); return emptyJoint(query); },
  });
  assert.equal(queries, 1); assert.deepEqual(preview.tools.map(row => row.name), ['get_research_stats']);
  assert.equal(preview.tools[0].result.jointMatchQueries, true);
});

test('a multi-token search_catalog call returns all requested aliases without extra provider requests', async () => {
  let completions = 0;
  await answerChat({ messages: [{ role: 'user', content: '查询目录。' }] }, { ...deps,
    chatCompletion: async messages => {
      completions++;
      if (completions === 1) return { message: { tool_calls: [{ id: 'names', function: { name: 'search_catalog', arguments: JSON.stringify({ query: '豹女 木木 饮血', kind: 'all' }) } }] } };
      const rows = JSON.parse(messages.find(row => row.role === 'tool').content).matched;
      for (const id of [nidalee.id, amumu.id, item('饮血剑').id]) assert.ok(rows.some(row => row.id === id));
      assert.ok(!rows.some(row => row.id === item('光明版饮血剑').id));
      return { message: { content: '已确认三个实体。' } };
    },
  });
  assert.equal(completions, 2);
});

test('pure definitions ignore page filters; nickname explanations also check current catalog identity', async () => {
  const pageContext = { view: 'explorer', research: { conditions: expected.slice(0, 2), minSample: 100 } };
  for (const text of ['D牌是什么意思？', '卡50慢D是什么意思？', '慢D和大D有什么区别，锁血是不是每回合赢？', '神装是什么意思？']) {
    const preview = await debugChatRetrieval({ question: text, pageContext }, { ...deps,
      getResearchResults: async () => { throw Error('Do not inherit filters for definitions'); },
      searchKnowledge: async input => { assert.equal(input.query, text); return { status: 'not_found', evidence: [] }; },
    });
    assert.deepEqual(preview.tools.map(row => row.name), ['search_knowledge']);
  }
  const identity = await debugChatRetrieval({ question: '板甲和反甲有什么区别？', pageContext }, { ...deps, searchKnowledge: async()=>({status:'not_found',evidence:[]}) });
  assert.deepEqual(identity.tools.map(row => row.name), ['search_catalog','search_knowledge']);
  const ids = identity.tools[0].result.matched.map(row => row.id);
  assert.ok(ids.includes(item('石像鬼石板甲').id)); assert.ok(ids.includes(item('棘刺背心').id));
  const stats = await debugChatRetrieval({ question: `大D完以后，${question}`, pageContext }, { ...deps, getResearchResults: async query => emptyJoint(query) });
  assert.deepEqual(stats.tools.map(row => row.name), ['get_research_stats']);
});

test('a named hero’s 神装 asks for observed builds, while the term alone remains a glossary question', async () => {
  let builds = 0;
  const preview = await debugChatRetrieval({ question: '豹女神装是什么？' }, { ...deps,
    getChampionBuild: async id => { builds++; assert.equal(id, nidalee.id); return { status: 'ready', data: [{ championId: id, itemIds: [item('饮血剑').id, item('石像鬼石板甲').id, item('棘刺背心').id], stats: { avgPlacement: 4.1, sampleSize: 123 } }] }; },
  });
  assert.equal(builds, 1); assert.deepEqual(preview.tools.map(row => row.name), ['get_champion_build']);
  const joint = resolveResearchIntent('豹女和木木一起上场，豹女毕业装是什么？', catalog);
  assert.equal(joint.carrierId, nidalee.id); assert.deepEqual(joint.conditions, expected.slice(0, 2));
});

test('the real Riot query DTO binds top-level, column and row statistics to Riot citations rather than static catalog evidence', async () => {
  const query = resolveResearchIntent(question, catalog);
  const ids = [item('饮血剑').id, item('石像鬼石板甲').id, item('棘刺背心').id];
  const metrics = { sample_size: 5, avg_placement: 4.2, top4_rate: .4, win_rate: 0, total_rows: 1 };
  const responses = [
    [{ matches: 12 }],
    [{ participants: 5, matches: 5, source_declared: 0, assigned: 5, platforms: 'KR', first_game: 1791475200000, last_game: 1791561600000, fetched_at: 1791600000000 }],
    [{ champion_id: nidalee.id, build_key: 'fixture-build', item_ids: JSON.stringify(ids), ...metrics }],
    [{ champion_id: catalog.champions[0].id, ...metrics }],
    [{ composition_key: 'fixture-comp', units_json: JSON.stringify([{ championId: nidalee.id }, { championId: amumu.id }]), ...metrics }],
  ];
  const dto = await getRiotResearchResults(query, catalog, { release: { season: 18, currentPatch: '18.4' }, db: { execute: async () => [responses.shift()] } });
  assert.equal(dto.source, 'riot');
  assert.equal(dto.equipment.evidence.source, 'Riot Games Match API');
  for (const onlyTopLevelEvidence of [false, true]) {
    const result = structuredClone(dto);
    if (onlyTopLevelEvidence) for (const key of ['equipment', 'teammates', 'comps']) delete result[key].evidence;
    const answer = await answerChat({ messages: [{ role: 'user', content: question }] }, { ...deps,
      getResearchResults: async () => result,
      chatCompletion: async messages => {
        const supplied = messages.find(row => row.role === 'system' && row.content.includes('"citationScope"'));
        assert.ok(supplied);
        const tool = JSON.parse(supplied.content.split('\n')[1]);
        assert.equal(tool.citation, '[S2]'); assert.deepEqual(tool.citations, ['[S2]']);
        for (const key of ['equipment', 'teammates', 'comps']) {
          assert.equal(tool[key].citation, '[S2]');
          assert.ok(tool[key].rows.every(row => row.citation === '[S2]'));
        }
        assert.match(messages[0].content, /CommunityDragon静态资料.*绝不支持统计结论/);
        return { message: { content: `饮血剑＋石像鬼石板甲＋棘刺背心，均次4.2，样本5。${tool.equipment.rows[0].citation}` } };
      },
    });
    const cited = answer.evidence.find(row => answer.reply.includes(`[${row.id}]`));
    assert.equal(cited.type, 'statistics'); assert.equal(cited.source, 'Riot Games Match API');
    assert.equal(cited.sourcePatch, null); assert.equal(cited.assignedPatch, '18.4');
    assert.match(cited.url, /^https:\/\/developer\.riotgames\.com\/apis#tft-match-v1/);
    assert.ok(answer.evidence.some(row => row.id === 'S1' && row.type === 'static'));
    assert.ok(!answer.reply.includes('[S1]'));
  }
});
