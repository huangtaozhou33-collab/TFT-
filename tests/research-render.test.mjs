import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { renderResearchExplorer } from '../public/research-explorer.js';

// A small DOM harness for the actual renderer: no browser/package/provider dependency.
// It models only DOM operations used here; end-to-end browser acceptance remains separate.
class TestNode {
  constructor(tag = '', text = '') { this.tagName = tag; this.children = []; this.attrs = {}; this.events = {}; this.value = ''; this._text = text; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get isConnected() { return this.connected === true || this.parent?.isConnected === true; }
  setAttribute(key, value) { this.attrs[key] = value; if (key === 'class') this.className = value; if (key === 'hidden') this.hidden = true; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...children); }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  fire(name) { for (const fn of this.events[name] || []) fn({ target: this, currentTarget: this, preventDefault() {} }); }
  click() { this.fire('click'); }
  focus() {}
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) { return all(this).filter(node => selector.startsWith('.') ? (node.className || '').split(' ').includes(selector.slice(1)) : node.tagName === selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function all(root) { return root.children.flatMap(child => [child, ...all(child)]); }
const saved = Object.fromEntries(['Node', 'document', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
before(() => {
  globalThis.Node = TestNode;
  globalThis.document = { createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('', text) };
  globalThis.location = { origin: 'http://localhost' };
});
after(() => { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const catalog = { champions: [{ id: 'nidalee', name: '奈德丽', cost: 4 }, { id: 'taric', name: '塔里克', cost: 5 }], items: [{ id: 'a', name: '青龙刀' }, { id: 'b', name: '法爆' }, { id: 'c', name: '帽子' }], traits: [] };
const stats = { sampleSize: 3, avgPlacement: 2.5, top4Rate: 0.7, winRate: 0.2 };
const evidence = { source: 'Riot Games Match API', sourcePatch: null, assignedPatch: '18.4' };
function response() {
  // Riot row contract intentionally has stats and no legacy deckIds.
  return { schemaVersion: 3, status: 'ok', coverage: { jointMatchQueries: true, matchedParticipants: 51, matchedMatches: 27, sourceMatches: 36 }, note: '同一玩家终局',
    equipment: { kind: 'observed_builds', label: '实际三件套', count: 1, evidence, rows: [{ championId: 'nidalee', itemIds: ['a', 'b', 'c'], stats, lowSample: true, warning: '样本仅 3 份玩家终局' }] },
    teammates: { label: '同一终局中的队友', count: 1, evidence, rows: [{ championId: 'taric', stats, lowSample: true }] },
    comps: { count: 1, evidence, rows: [{ name: '奈德丽 · 塔里克', units: [{ championId: 'nidalee', items: [] }, { championId: 'taric', items: [] }], stats }] } };
}
function mount(api, options = {}) {
  const main = new TestNode('main'); main.connected = true;
  renderResearchExplorer(main, { catalog, api, query: { conditions: [{ type: 'champion', id: 'nidalee' }], minSample: 100 }, ...options });
  return main;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const named = (root, name) => all(root).find(node => node.attrs['aria-label'] === name);
function panel(root, name) {
  const section = named(root, `${name}结果`);
  return { body: section.querySelector('.research-column-body'), label: section.querySelector('.research-column-label'), count: section.children[0].children[1] };
}

test('Riot stats-only rows render equipment, teammates and compositions through the v3 endpoint', async () => {
  let request;
  const main = mount(async (path, body) => { request = { path, body }; return response(); });
  await settle();
  assert.equal(request.path, '/api/research/query/v3');
  assert.equal(request.body.conditions[0].id, 'nidalee');
  assert.equal(request.body.carrierId, 'nidalee');
  assert.match(main.textContent, /51 份玩家终局 · 27 场比赛/);
  for (const name of ['装备', '队友', '推荐阵容']) assert.equal(panel(main, name).count.textContent, '1');
  assert.equal(panel(main, '装备').body.querySelectorAll('.data-icon-button').length, 3);
  assert.match(panel(main, '装备').body.textContent, /样本仅 3/);
  assert.match(panel(main, '队友').body.textContent, /塔里克.*均次2.5/);
  assert.match(panel(main, '推荐阵容').body.textContent, /奈德丽 · 塔里克/);
  assert.doesNotMatch(main.textContent, /显示异常|Cannot|0 套匹配阵容/);
});

test('one malformed result column fails visibly without discarding the other two columns', async () => {
  const data = response(); data.equipment.rows.push({ championId: 'nidalee', stats });
  const main = mount(async () => data); await settle();
  assert.equal(panel(main, '装备').count.textContent, '');
  assert.equal(panel(main, '装备').label.textContent, '');
  assert.match(panel(main, '装备').body.textContent, /结果已返回.*无法显示.*刷新/);
  assert.equal(panel(main, '装备').body.querySelectorAll('.research-build').length, 0);
  for (const name of ['队友', '推荐阵容']) { assert.equal(panel(main, name).count.textContent, '1'); assert.match(panel(main, name).body.textContent, /塔里克/); }
  assert.match(main.textContent, /1 栏显示异常/);
  assert.doesNotMatch(main.textContent, /没有.*记录|Cannot|undefined/);
});

test('a query failure after success clears previous counts, labels and data while preserving conditions', async () => {
  let calls = 0;
  const main = mount(async () => { if (++calls === 1) return response(); throw new Error('筛选器已更新，请刷新页面后重试，当前筛选条件会保留。'); });
  await settle();
  const sort = named(main, '检索结果排序'); sort.value = 'sampleSize'; sort.fire('change'); await settle();
  assert.equal(calls, 2);
  for (const name of ['装备', '队友', '推荐阵容']) {
    const p = panel(main, name); assert.equal(p.count.textContent, ''); assert.equal(p.label.textContent, '');
    assert.match(p.body.textContent, /请刷新页面后重试/); assert.equal(p.body.querySelectorAll('article').length, 0);
  }
  assert.match(main.textContent, /查询未完成/);
  assert.ok(named(main, '移除奈德丽条件'));
  assert.equal(main.querySelector('.data-evidence').hidden, true);
  const toggle = named(main, '奥恩神器'); toggle.checked = false; toggle.fire('change');
  assert.equal(calls, 2);
  assert.match(panel(main, '装备').body.textContent, /请刷新页面后重试/);
  assert.equal(panel(main, '装备').body.querySelectorAll('article').length, 0);
});

test('an unsupported response contract is a display error, never an empty data result', async () => {
  const data = response(); data.schemaVersion = 1;
  const main = mount(async () => data); await settle();
  assert.match(main.textContent, /结果暂时无法显示，请刷新重试/);
  for (const name of ['装备', '队友', '推荐阵容']) assert.equal(panel(main, name).count.textContent, '');
  assert.doesNotMatch(main.textContent, /Cannot|undefined|没有.*记录/);
});

test('a real zero-match response displays its explicit no-sample reason with zero counts', async () => {
  const data = response(); data.status = 'empty'; data.coverage.matchedParticipants = 0; data.coverage.matchedMatches = 0;
  for (const key of ['equipment', 'teammates', 'comps']) { data[key].rows = []; data[key].count = 0; data[key].reason = '当前已采集比赛中没有满足全部条件的玩家终局。'; }
  const main = mount(async () => data); await settle();
  const toggle = named(main, '光明装备'); toggle.checked = false; toggle.fire('change');
  for (const name of ['装备', '队友', '推荐阵容']) { assert.equal(panel(main, name).count.textContent, '0'); assert.match(panel(main, name).body.textContent, /没有满足全部条件/); }
  assert.match(main.textContent, /0 份玩家终局 · 0 场比赛/);
  assert.doesNotMatch(main.textContent, /显示异常|无法显示/);
});

test('legacy OP.GG rows retain their own labels while the new page requests MetaTFT',async()=>{
  const data=response(); data.source='opgg';data.coverage={jointMatchQueries:false,qualifiedBuilds:4,matchedChampions:1,availableSnapshots:2};
  data.teammates={kind:'build_carriers',label:'各棋子排序首位三件套 · 指标仅属于所示组合',rows:[{championId:'taric',itemIds:['a','b','c'],qualifyingBuildCount:4,stats}],count:1};
  data.comps={rows:[],count:0,status:'not_supported',reason:'请切换同局阵容',label:'同局阵容'};
  const requests=[];const main=mount(async(path,body)=>{requests.push(body);return data;});await settle();
  assert.match(main.textContent,/OP.GG · 4 组出装 · 1 个棋子/);
  assert.match(panel(main,'棋子').body.textContent,/塔里克.*4 组匹配出装/);
  assert.equal(panel(main,'棋子').body.querySelectorAll('.data-icon').length,4);
  assert.match(panel(main,'棋子').label.textContent,/仅属于所示组合/);
  assert.doesNotMatch(main.textContent,/0 套匹配阵容|4 场比赛|4 份玩家终局/);
  assert.equal(requests.at(-1).dataSource,'metatft');
});

test('MetaTFT shows persisted conditional samples and holders without inventing match counts',async()=>{
  const data=response();data.source='metatft';data.coverage={jointMatchQueries:false,matchedSamples:900,cacheHit:true};
  data.evidence={source:'MetaTFT Explorer',sourcePatch:null,requestedPatch:'18.4b',sourceCurrentPatch:'18.4b',patchAttribution:{method:'explicit_request_and_source_metadata'}};
  data.equipment.evidence=data.evidence;data.teammates.kind='item_holders';data.teammates.label='所选装备的持有棋子';
  const main=mount(async()=>data);await settle();
  assert.match(main.textContent,/MetaTFT · 900 份统计样本 · MySQL 已存快照/);
  assert.match(panel(main,'棋子').body.textContent,/塔里克/);
  assert.match(main.textContent,/18.4b · 查询范围/);
  assert.doesNotMatch(main.textContent,/900 场比赛|51 份玩家终局/);
});

const categoryCatalog = { ...catalog, items: [...catalog.items, { id: 'artifact', name: '神器', category: 'artifact' }, { id: 'radiant', name: '光明', category: 'radiant' }] };
function categoryResponse(builds = [['a','b','c'],['artifact','b','c'],['a','radiant','c'],['artifact','radiant','c'],['unknown','b','c']]) {
  const data = response(); data.source = 'metatft'; data.coverage = { matchedSamples: 900, cacheHit: true };
  data.equipment.rows = builds.map(itemIds => ({ championId: 'nidalee', itemIds, stats }));
  data.equipment.count = builds.length;
  return data;
}
function toggle(root, name, checked) { const input = named(root, name); input.checked = checked; input.fire('change'); }

test('build categories filter whole builds without changing the cohort, other columns or source requests; URL state restores', async () => {
  const requests = []; let saved;
  const api = async (path, body) => { requests.push(body); return categoryResponse(); };
  const main = mount(api, { catalog: categoryCatalog, onChange: value => { saved = value; } }); await settle();
  assert.equal(named(main, '奥恩神器').checked, true);
  assert.equal(named(main, '光明装备').checked, true);
  const teammate = panel(main, '队友').body.children[0], comp = panel(main, '推荐阵容').body.children[0];
  assert.equal(panel(main, '装备').count.textContent, '5');
  toggle(main, '奥恩神器', false);
  assert.equal(panel(main, '装备').count.textContent, '显示 3 / 5');
  assert.equal(named(main, '筛选神器'), undefined);
  assert.ok(named(main, '筛选光明'));
  toggle(main, '光明装备', false);
  assert.equal(panel(main, '装备').count.textContent, '显示 2 / 5');
  assert.equal(named(main, '筛选光明'), undefined);
  assert.ok(named(main, '待核对装备 · unknown')); // Unknown categories are never guessed.
  assert.equal(panel(main, '队友').body.children[0], teammate);
  assert.equal(panel(main, '推荐阵容').body.children[0], comp);
  assert.match(main.textContent, /900 份统计样本/);
  assert.equal(requests.length, 1);
  const restored = mount(api, { catalog: categoryCatalog, query: JSON.parse(JSON.stringify(saved)) }); await settle();
  assert.equal(Boolean(named(restored, '奥恩神器').checked), false);
  assert.equal(Boolean(named(restored, '光明装备').checked), false);
  assert.equal(panel(restored, '装备').count.textContent, '显示 2 / 5');
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(Object.hasOwn(requests[1], 'buildDisplay'), false);
  toggle(restored, '奥恩神器', true);
  assert.equal(panel(restored, '装备').count.textContent, '显示 3 / 5');
  toggle(restored, '光明装备', true);
  assert.equal(panel(restored, '装备').count.textContent, '5');
});

test('hiding an explicitly required item category preserves the condition and distinguishes hidden builds from zero samples', async () => {
  let saved;
  const main = mount(async () => categoryResponse([['artifact','b','c']]), { catalog: categoryCatalog,
    query: { conditions: [{type:'champion',id:'nidalee'},{type:'item',id:'artifact',holderId:'nidalee'}] }, onChange: value => { saved = value; } });
  await settle(); toggle(main, '奥恩神器', false);
  assert.equal(panel(main, '装备').count.textContent, '显示 0 / 1');
  assert.match(panel(main, '装备').body.textContent, /当前装备类别选择下没有可展示的出装/);
  assert.match(main.textContent, /900 份统计样本/);
  assert.ok(named(main, '移除神器条件'));
  assert.deepEqual(saved.conditions[1], { type:'item', id:'artifact', holderId:'nidalee' });
  toggle(main, '奥恩神器', true);
  assert.equal(panel(main, '装备').count.textContent, '1');
});

test('category changes during a pending query apply to the new response without resurrecting previous builds', async () => {
  let finish, calls = 0;
  const main = mount(async () => ++calls === 1 ? categoryResponse() : new Promise(resolve => { finish = resolve; }), { catalog: categoryCatalog });
  await settle();
  const sort = named(main, '检索结果排序'); sort.value = 'sampleSize'; sort.fire('change');
  toggle(main, '光明装备', false);
  assert.match(panel(main, '装备').body.textContent, /正在筛选/);
  assert.equal(panel(main, '装备').body.querySelectorAll('article').length, 0);
  finish(categoryResponse([['a','radiant','c']])); await settle();
  assert.equal(calls, 2);
  assert.equal(panel(main, '装备').count.textContent, '显示 0 / 1');
});
