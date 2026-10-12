import {openModelSettings} from './model-settings.js';
import {initLanguage,getLanguage,englishText,hasSourceTranslation} from './i18n.js';
import { renderPatchNotes } from './patch-notes.js';
import { pageRank, savePageRank } from './stat-ranks.js';
import { renderChatCards } from './chat-cards.js';
import { normalizeExplorerQuery, filterExplorerRows, sortExplorerRows, getRowEntities, encodeExplorerQuery, decodeExplorerQuery } from './explorer.js';
import { buildExplorerIndex, searchExplorerEntities } from './explorer-search.js';
import { renderDeveloper } from './developer.js';
import { renderComps, invalidateComps } from './comps.js';
import { watchStatistics } from './statistics-refresh.js';
import { renderTeamPlanner } from './team-planner.js';
import { createLineupFromDeck } from './lineup-model.js';
import { LIBRARY_ROUTES, renderLibraryHub, renderLibraryBrowser, entityDocuments, createLibraryDocument, createAugmentOffering, searchLibrary, filterGlossaryEntries } from './library.js';
import { initAppearance, versionContext } from './appearance.js';
import { renderStatsBrowser, invalidateStats } from './stats-browser.js';
import { renderResearchExplorer } from './research-explorer.js';
import { normalizeResearchQuery, researchFromLegacy, validateResearchQuery } from './research-query.js';
import { offeringPreview, offeringWindowAt, mechanicSearchText } from './mechanic-browser.js';
import { patchContext } from './patch-context.js';

const $ = (selector, root = document) => root.querySelector(selector);
const STORAGE = { draft: 'tft.atelier.draft.v1', saved: 'tft.atelier.saved.v1' };
const VIEWS = [
  ['comps', '阵容首页', '♙'], ['team-planner', '阵容规划器', '⬡'],
  ['stats', '大数据', '▦'], ['explorer', '筛选器', '⌕'],
  ['patch-notes', '版本更新', '↻'], ['developer', '开发者模式', '⌘'],
  ['library', '资料库', '▤'], ['mechanics', '赛季特殊玩法', '❋'], ['guide', '资料库', '▤'], ['champions', '英雄资料', '♙'], ['items', '装备资料', '◈'], ['traits', '羁绊图鉴', '⌘'], ['augments', '强化符文', '✧'], ['recipes', '合成图鉴', '⚒'], ['artifacts', '奥恩神器', '✦'], ['radiant','光明装备','✧'],
  ['systems','系统规则与概率','▦'], ['trait-rules','羁绊机制细则','⌘'], ['wisp-rules','赛季特殊玩法','❋'], ['reference','实用速查','◷'], ['glossary','云顶术语','字'],
];
const GUIDE_VIEWS = new Set(['library', 'guide', 'champions', 'items', 'traits', 'augments', 'recipes', 'artifacts', 'radiant', 'mechanics', ...Object.keys(LIBRARY_ROUTES)]);
const NAV_VIEWS = ['comps', 'team-planner', 'stats', 'explorer', 'library', 'patch-notes', 'developer'];
function visibleRoute(view) { return VIEWS.some(([id]) => id === view) ? view : ['workbench', 'learn', 'saved', 'favorites'].includes(view) ? 'stats' : 'comps'; }
const STAT_TABS = [['units', '弈子'], ['traits', '羁绊'], ['equipment', '装备'], ['twoitems', '二件装'], ['champions', '三神装'], ['decks', '变阵'], ['counters', '克制'], ['itemcounts', '装备数量'], ['stars', '弈子星级'], ['matches', '最近对局'], ['items', '装备适配'], ['emblems', '转职专栏']];
const TYPE_LABELS = { champions: '英雄', items: '装备', traits: '羁绊', augments: '强化符文' };
const ROLE_LABELS = { carry: '主力输出', tank: '前排承伤', support: '辅助 / 功能' };
const COST_COLORS = { 1: '#637680', 2: '#68a383', 3: '#6ba4d0', 4: '#ba8bd5', 5: '#d7b373', 6: '#df886d', 7: '#df886d' };
const freshDraft = () => ({ version: 1, units: [], components: {}, completedItems: {}, reserve: {}, preferences: {} });
const state = {
  catalog: { context: {}, champions: [], items: [], traits: [], augments: [] }, decks: null, sources: null, health: null,
  view: visibleRoute(location.hash.slice(1)), entityId: null,
  library: null, libraryLoading: false, libraryDocumentId: new URL(location.href).searchParams.get('topic'),
  glossary: null, glossaryTermId: new URL(location.href).searchParams.get('term'),
  developerTraceId: null,
  initialLineup: null,
  initialCompId: null, research: normalizeResearchQuery(),
  plannerController: null,
  draft: freshDraft(), plan: null, messages: [], saved: [], inventoryTab: 'components', planning: false, chatting: false,
  catalogError: null, planError: null, draftContextKey: null, draftContext: null, filter: { search: '', cost: '', kind: '' }, chatVisible: false, pendingActions: [],
  statsOverview: null, statsError: null, statsLoading: false, statsTab: 'units', statEntity: null, traitStats: null, traitStatsLoading: false,
  mechanics: null, mechanicsLoading: false, mechanicsSection: 'conditions', mechanicsSelectedId: '', mechanicEntity: null, mechanicsPage: 1, mechanicsFilter: { search: '', category: '', stage: '', rating: '', variant: '', round: '', coverage: '' },
  statsSelections: { champions: '', items: '', emblems: '' }, statsResults: {}, statsRequests: {},
  statsPages: { champions: 1, items: 1, emblems: 1, traits: 1 }, emblemResearchChampionId: '',
  statsFilters: Object.fromEntries(['decks', 'champions', 'items', 'emblems', 'traits'].map(id => [id, { search: '', minSample: 100, sort: 'avgPlacement' }]))
};
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'disabled' || key === 'selected' || key === 'checked') node[key] = Boolean(value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function str(value, fallback = '未知') { return value == null || value === '' ? fallback : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function entityName(entity) { return str(entity?.name || entity?.id, '未识别实体'); }
function byId(type, id) { return state.catalog[type]?.find(x => x.id === id); }
function entityImage(entity, className = '') {
  const box = el('span', { class: `entity-image ${className}`, 'aria-hidden': 'true' });
  const fallback = el('span', { class: 'image-fallback', text: entityName(entity).slice(0, 1) });
  box.append(fallback);
  const src = safeUrl(entity?.icon);
  if (src) {
    const img = el('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => fallback.remove());
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}
function itemTinyImage(item) {
  const src = safeUrl(item?.icon);
  return src ? el('img', { src, alt: '', loading: 'lazy', onerror: event => event.currentTarget.remove() }) : null;
}
function readableDescription(value, fallback = '来源未提供文本') {
  return str(value, fallback).replace(/\\n/g, '\n').replace(/\\r/g, '');
}
const btn = (text, onClick, cls = 'secondary', disabled = false) => el('button', { type: 'button', class: `button ${cls}`, onclick: onClick, disabled }, text);
function toast(text, error = false) {
  const item = el('div', { class: `toast${error ? ' error' : ''}`, role: 'status', text });
  $('#toast-region').append(item); setTimeout(() => item.remove(), 4500);
}
function readLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function writeLocal(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { toast('浏览器未允许本地保存，请检查存储空间。', true); return false; } }
function number(value) { return Math.max(0, Math.min(99, Math.floor(Number(value) || 0))); }
function cleanCounts(input) {
  const out = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) for (const [id, qty] of Object.entries(input)) {
    if (!['__proto__', 'constructor', 'prototype'].includes(id) && number(qty)) out[id] = number(qty);
  }
  return out;
}
function normalizeDraft(input) {
  if (!input || !Array.isArray(input.units)) throw new Error('草案格式无效');
  return {
    version: Math.max(1, Math.floor(Number(input.version) || 1)),
    units: input.units.slice(0, 12).filter(u => u && typeof u.championId === 'string').map((u, i) => ({
      instanceId: typeof u.instanceId === 'string' ? u.instanceId : `restored-${i}`,
      championId: u.championId, role: Object.hasOwn(ROLE_LABELS, u.role) ? u.role : 'carry',
      priority: Math.max(1, Math.min(99, number(u.priority) || 1)),
      lockedItems: Array.isArray(u.lockedItems) ? u.lockedItems.filter(x => typeof x === 'string').slice(0, 3) : []
    })),
    components: cleanCounts(input.components), completedItems: cleanCounts(input.completedItems), reserve: cleanCounts(input.reserve),
    preferences: input.preferences && typeof input.preferences === 'object' ? Object.fromEntries(Object.entries(input.preferences).filter(([id, items]) => !['__proto__', 'constructor', 'prototype'].includes(id) && Array.isArray(items)).map(([id, items]) => [id, items.filter(x => typeof x === 'string').slice(0, 20)])) : {}
  };
}
function contextKey(context = state.catalog.context) {
  return [context.game || 'TFT', context.set || context.setNumber || context.set_name || context.setName || 'unknown', context.asset_version || context.assetVersion || 'unknown', context.rulesVersion || context.rules_version || 'unknown'].join(':');
}
function draftContextBlocked() { return Boolean(state.draftContextKey && state.draftContextKey !== contextKey()); }
function persistDraft() { writeLocal(STORAGE.draft, { schemaVersion: 1, contextKey: state.draftContextKey || contextKey(), context: state.draftContext || state.catalog.context, draft: state.draft }); }
function editDraft(mutator, notice) {
  if (draftContextBlocked()) return toast('当前草案来自其他资源或规则版本，请先新建当前版本草案。', true);
  mutator(state.draft); state.draft.version += 1; state.planError = null; persistDraft(); renderMain(); renderChat(); updateChatContext();
  if (notice) toast(notice);
}
function countValues(values = {}) { return Object.values(values).reduce((sum, qty) => sum + (Number(qty) || 0), 0); }
function currentPlan() { return state.plan && Number(state.plan.draftVersion) === state.draft.version; }
function isReadOnlyStats() { return ['comps', 'team-planner', 'stats', 'explorer', 'decks', 'mechanics'].includes(state.view) || GUIDE_VIEWS.has(state.view); }
function sameCatalog(saved) { return !saved.contextKey || saved.contextKey === contextKey(); }
function catalogMissing(draft) {
  return draft.units.some(u => !byId('champions', u.championId)) || [...Object.keys(draft.components), ...Object.keys(draft.completedItems), ...Object.keys(draft.reserve), ...draft.units.flatMap(u => u.lockedItems), ...Object.values(draft.preferences || {}).flat()].some(id => !byId('items', id));
}
async function api(path, body, timeout = 30000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    let data; try { data = await res.json(); } catch { throw new Error('服务返回了无法解析的响应'); }
    if (!res.ok) {
      const error = new Error(str(data.message || data.error?.message || data.error || data.reason, `请求失败（${res.status}）`));
      if (typeof data.traceId === 'string') error.traceId = data.traceId;
      if (typeof data.code === 'string') error.code = data.code;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时，请重试或查看数据源状态。');
    if (/failed to fetch|networkerror|load failed/i.test(error.message || '')) throw new Error('暂时无法连接服务，请稍后重试。');
    throw error;
  } finally { clearTimeout(timer); }
}
function navigate(view, traceId = null) {
  if (view === 'sources') return showSourceDetails();
  view = visibleRoute(view);
  if (state.view === 'team-planner' && state.plannerController) {
    if (view === state.view && !state.initialLineup) return;
    if (state.plannerController.hasUnsavedChanges()) {
      history.replaceState(null, '', '#team-planner');
      openModal('笔记尚未保存', el('div', {}, el('p', { text: '离开会丢弃尚未保存的修改。可以先保存到个人阵容池。' }),
        el('div', { class: 'actions' }, btn('保留编辑', closeModal, 'secondary'), btn('丢弃修改并离开', () => {
          closeModal(); state.plannerController = null; navigate(view, traceId);
        }, 'primary'))));
      return;
    }
  }
  const routeChanged=state.view!==view;
  state.view = view; state.entityId = null; state.statEntity = null; state.mechanicEntity = null; state.libraryDocumentId = null; state.glossaryTermId = null; state.filter = { search: '', cost: '', kind: '' };
  state.developerTraceId = view === 'developer' && typeof traceId === 'string' ? traceId : null;
  const routeURL=new URL(location.href);routeURL.searchParams.delete('topic');routeURL.searchParams.delete('term');routeURL.hash=view;history.replaceState(null,'',routeURL);
  if (view === 'explorer') readResearchQueryFromUrl();
  $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false');
  renderNav(); renderMain(); updateChatContext(); renderSuggestions();
  if(routeChanged){window.scrollTo(0,0);$('#main').focus({preventScroll:true});}
  if (['mechanics','wisp-rules','library','guide'].includes(view) && !state.mechanics && !state.mechanicsLoading) loadMechanics();
  if (GUIDE_VIEWS.has(view) && !state.library) loadLibrary();
  if (['library','guide','glossary'].includes(view) && !state.glossary) loadGlossary();
}
function renderNav() {
  const nav = $('#nav'); nav.replaceChildren();
  NAV_VIEWS.map(id => VIEWS.find(view => view[0] === id)).forEach(([id, label, icon, badge]) => {
    if (id === 'library') nav.append(el('p', { class: 'nav-group-label', text: '资料库' }));
    if (id === 'developer') nav.append(el('p', { class: 'nav-group-label', text: '开发工具' }));
    const active = state.view === id || id === 'library' && GUIDE_VIEWS.has(state.view);
    const link = el('button', { class: `nav-link${active ? ' active' : ''}`, 'aria-current': active ? 'page' : null, onclick: () => navigate(id) },
      el('span', { class: 'nav-icon', 'aria-hidden': 'true', text: icon }), label, badge ? el('span', { class: 'nav-badge', text: badge }) : null);
    nav.append(link);
  });
  const title = VIEWS.find(([id]) => id === state.view)?.[1] || '大数据';
  $('#breadcrumb').textContent = GUIDE_VIEWS.has(state.view) && !['guide', 'library'].includes(state.view) ? `资料库 / ${title}` : title;
}
function renderContext() {
  const c = state.catalog.context || {};
  const game = c.game === 'tft' || !c.game ? 'TFT · 国际服' : c.game;
  const versions = versionContext(state);
  const metric = (label, value, cls = '') => el('div', {class:`version-metric ${cls}`},el('span',{text:label}),el('strong',{text:value}));
  const details = el('details',{class:'version-details'},el('summary',{},el('span',{text:'版本详情'}),el('span',{'aria-hidden':'true',text:'↗'})),
    el('div',{class:'version-popover'},el('strong',{text:'资料版本说明'}),
      el('dl',{},[['应用版本',`V${versions.appVersion}`],['游戏',game],['赛季',str(versions.season)],['游戏补丁',versions.gamePatch || '尚未核验'],['机制资料补丁',versions.rulePatch || '尚未载入'],['资源版本',versions.assetVersion || '未知'],['统计补丁',versions.statPatch || '未知']].map(([label,value])=>[el('dt',{text:label}),el('dd',{text:value})])),
      el('p',{text:'资料来源补丁与游戏补丁分别记录。旧版、冲突或未核验的表格以条目标记为准。'})));
  const node = $('#context-bar'); node.replaceChildren(
    el('div',{class:'version-release'},el('span',{class:'version-release-label'},el('span',{class:'version-live-dot','aria-hidden':'true'}),'当前应用版本'),el('strong',{text:`V${versions.appVersion}`})),
    metric('当前赛季',versions.season ? `S${versions.season}` : '待载入'),
    metric('机制资料补丁',versions.rulePatch || '待载入'),
    el('div',{class:'version-trust'},el('span',{class:`version-game-patch ${versions.gamePatch?'confirmed':'unconfirmed'}`,text:versions.gamePatch?`游戏补丁 ${versions.gamePatch}`:'游戏补丁待核验'}),el('small',{text:game})),details
  );
}
function heading(eyebrow, title, description, actions = []) {
  return el('div', { class: 'page-heading' }, el('div', {}, el('span', { class: 'eyebrow', text: eyebrow }), el('h1', {}, title, el('span', { class: 'page-index', text: ' / 01' })), el('p', { text: description })), actions.length ? el('div', { class: 'actions' }, actions) : null);
}
function renderMain() {
  const main = $('#main'); main.replaceChildren();
  state.plannerController = null;
  $('#content-layout').classList.toggle('developer-mode', state.view === 'developer');
  if (state.view === 'comps') { const initialCompId = state.initialCompId; state.initialCompId = null; renderComps(main, { catalog: state.catalog, api, toast, initialCompId, onEdit: deck => {
    state.initialLineup = createLineupFromDeck(deck, state.catalog); navigate('team-planner');
  } }); }
  else if (state.view === 'team-planner') {
    const initialLineup = state.initialLineup; state.initialLineup = null;
    state.plannerController = renderTeamPlanner(main, { catalog: state.catalog, api, toast, initialLineup, rulesPatch:versionContext(state).rulePatch });
  }
  else if (state.view === 'guide' || state.view === 'library') renderGuide(main);
  else if (state.view === 'patch-notes') renderPatchNotes(main,{api});
  else if (state.view === 'developer') renderDeveloper(main, { api, traceId: state.developerTraceId });
  else if (state.view === 'stats') renderStats(main);
  else if (state.view === 'explorer') renderResearchExplorer(main, {
    catalog: state.catalog, api, query: {...state.research, rank:pageRank()},
    onChange: query => { state.research = query; saveResearchQuery(); state.entityId = null; updateChatContext(); },
    onSelect: entity => { state.entityId = entity?.id || null; updateChatContext(); },
    onComp: deck => { state.initialCompId = deck.id; navigate('comps'); }
  });
  else if (['mechanics','wisp-rules'].includes(state.view)) renderMechanics(main);
  else if (LIBRARY_ROUTES[state.view]) {
    const glossary=state.view==='glossary';
    main.append(guideNav(), heading(glossary?'常用说法与概念':'规则与条件', VIEWS.find(([id])=>id===state.view)[1], glossary?'查术语、别名与例句，理解玩家的对局表达。通用术语由本项目整理。':'查中文表格，按条件核对奖励、概率与触发效果。'));
    renderLibraryBrowser(main, { ...libraryOptions(), snapshot:state.library, category:LIBRARY_ROUTES[state.view], selectedId:glossary?state.glossaryTermId:state.libraryDocumentId, onSelect:glossary?selectGlossaryEntry:selectLibraryDocument, onNavigate:navigate });
  }
  else if (state.view === 'radiant') renderCatalog(main, 'items', { category: 'radiant' });
  else if (state.view === 'artifacts') renderCatalog(main, 'items', { category: 'artifact' });
  else if (TYPE_LABELS[state.view]) renderCatalog(main, state.view);
  else if (state.view === 'recipes') renderRecipes(main);
  else renderStats(main);
}
function guideNav() {
  return el('nav', { class: 'guide-page-nav', 'aria-label': '图鉴内导航' },
    el('a', { href: '#library', class: 'guide-back', text: '← 资料库首页' }),
    [['champions', '英雄资料'], ['items', '装备资料'], ['traits', '羁绊图鉴'], ['augments', '海克斯'], ['recipes', '合成图鉴'], ['mechanics', '赛季特殊玩法'], ['systems','系统规则'], ['trait-rules','羁绊细则'], ['reference','实用速查'], ['glossary','云顶术语']].map(([id, label]) => {
      const active = state.view === id || id === 'items' && state.view === 'artifacts' || id === 'mechanics' && state.view === 'wisp-rules';
      return el('a', { href: `#${id}`, class: active ? 'active' : '', 'aria-current': active ? 'page' : null, text: label });
    }));
}
function guideCount(type) {
  if (type === 'recipes') return state.catalog.items.filter(i => i.recipeVerified === true && i.components?.length === 2 && i.components.every(id => byId('items', id)?.kind === 'component')).length;
  return state.catalog[type]?.length || 0;
}
function renderGuide(main) {
  main.append(heading('THE FIELD GUIDE · V4', '资料库', '英雄、装备与海克斯图鉴，以及中文机制、概率和奖励速查。'));
  renderLibraryHub(main, {snapshot:state.library,mechanics:state.mechanics,glossary:state.glossary,el,btn,onNavigate:navigate,onOpen:openLibraryDocument,onMechanic:openMechanicDetail,onGlossary:openGlossaryEntry});
  const sections = [
    ['champions', '英雄资料', '♙', '费用、羁绊与技能，理解每个棋子的任务。', '个英雄 / 形态'],
    ['items', '装备资料', '◈', '基础散件、合成装备与特殊装备，核对每一次选择。', '件装备'],
    ['traits', '羁绊图鉴', '⌘', '查看羁绊效果与触发档位。', '个羁绊'],
    ['augments', '海克斯 / 强化符文', '✧', '点进详情查奖励分支、概率、出现条件与互斥强化。', '个强化符文'],
    ['recipes', '合成图鉴', '⚒', '查看常规成装与转职纹章的已验证合成配方。', '条已验证配方']
  ];
  const grid = el('div', { class: 'guide-hub-grid' });
  sections.forEach(([id, title, icon, description, unit], index) => {
    const previews = (id === 'recipes' ? state.catalog.items.filter(i => i.kind === 'component') : state.catalog[id] || []).slice(0, 3);
    grid.append(el('a', { href: `#${id}`, class: `guide-hub-card guide-hub-${id}` },
      el('div', { class: 'guide-card-top' }, el('span', { class: 'guide-card-icon', 'aria-hidden': 'true', text: icon }), el('span', { class: 'guide-card-number', text: `0${index + 1}` })),
      el('h2', { text: title }), el('p', { text: description }),
      el('div', { class: 'guide-card-footer' }, el('span', { class: 'guide-card-count', text: `${guideCount(id)} ${unit}` }), el('div', { class: 'guide-card-previews', 'aria-hidden': 'true' }, previews.map(entity => entityImage(entity))), el('span', { class: 'guide-card-arrow', 'aria-hidden': 'true', text: '↗' }))));
  }); main.append(grid);
  const artifacts = state.catalog.items.filter(i => i.category === 'artifact');
  main.append(el('a', { class: 'guide-artifact-callout', href: '#artifacts' }, el('span', { class: 'artifact-callout-symbol', 'aria-hidden': 'true', text: '✦' }), el('div', {}, el('span', { class: 'eyebrow', text: 'ORNN’S FORGE' }), el('h2', { text: '奥恩神器' }), el('p', { text: '作为独立装备分类查看，只展示当前资料包中标记为神器的真实条目。' })), el('span', { class: 'artifact-callout-count', text: `${artifacts.length} 件` }), el('span', { 'aria-hidden': 'true', text: '↗' })));
  main.append(el('a', { class: 'guide-artifact-callout', href: '#mechanics' }, el('span', { class: 'artifact-callout-symbol', 'aria-hidden': 'true', text: '❋' }), el('div', {}, el('span', { class: 'eyebrow', text: 'SEASON MECHANICS' }), el('h2', { text: '赛季特殊玩法' }), el('p', { text: '查看法杖效果、出现条件与攻略评级。' })), el('span', { 'aria-hidden': 'true', text: '↗' })));
  if (state.catalogError) main.append(el('div', { class: 'error-box', style: { marginTop: '18px' }, text: `资料库加载失败：${state.catalogError}` }));
  main.append(el('p', { class: 'footer-note', text: '条目数量表示当前版本资源包的实际覆盖。资料缺失和无法解析的数值会明确标记，统计使用情况以本地版本缓存状态为准。' }));
}
function equipmentCategoryNav() {
  const count = state.catalog.items.filter(i => i.category === 'artifact').length;
  return el('nav', { class: 'equipment-category-nav', 'aria-label': '装备资料分类' },
    el('a', { href: '#items', class: state.view === 'items' ? 'active' : '', 'aria-current': state.view === 'items' ? 'page' : null, text: '全部装备' }),
    el('a', { href: '#artifacts', class: state.view === 'artifacts' ? 'active' : '', 'aria-current': state.view === 'artifacts' ? 'page' : null }, el('span', { 'aria-hidden': 'true', text: '✦' }), ` 奥恩神器`, el('span', { class: 'category-count', text: count })), el('a',{href:'#radiant',class:state.view==='radiant'?'active':''},'光明装备',el('span',{class:'category-count',text:state.catalog.items.filter(i=>i.category==='radiant').length})));
}
let libraryRequest;
async function loadLibrary() {
  if(libraryRequest)return libraryRequest;
  state.libraryLoading=true;
  libraryRequest=api('/api/library').then(snapshot=>{state.library=snapshot;return snapshot;}).catch(error=>{state.library={status:'not_cached',documents:[],augmentRules:[],reason:error.message};return state.library;}).finally(()=>{state.libraryLoading=false;libraryRequest=null;if(GUIDE_VIEWS.has(state.view))renderMain();});
  return libraryRequest;
}
let glossaryRequest;
function loadGlossary() {
  if(glossaryRequest)return glossaryRequest;
  glossaryRequest=api('/api/glossary').then(snapshot=>{state.glossary=snapshot;return snapshot;}).catch(error=>{state.glossary={entries:[],reason:error.message};return state.glossary;}).finally(()=>{glossaryRequest=null;if(['library','guide','glossary'].includes(state.view))renderMain();});
  return glossaryRequest;
}
function selectGlossaryEntry(entry) {
  state.glossaryTermId=entry.id;state.libraryDocumentId=null;state.entityId=null;state.mechanicEntity=null;
  const url=new URL(location.href);url.searchParams.delete('topic');url.searchParams.set('term',entry.id);history.replaceState(null,'',url);updateChatContext();renderSuggestions();
}
function openGlossaryEntry(entry) {
  closeModal();navigate('glossary');selectGlossaryEntry(entry);renderMain();
}
function askGlossaryEntry(entry) {
  selectGlossaryEntry(entry);showChat(true);$('#chat-input').value=`${entry.term}是什么意思？请举一个对局中的例子，并说明常见误解。`;$('#chat-input').focus();
}
function selectLibraryDocument(doc) {
  state.libraryDocumentId=doc.id;state.entityId=null;state.mechanicEntity=null;
  const url=new URL(location.href);url.searchParams.set('topic',doc.id);history.replaceState(null,'',url);updateChatContext();renderSuggestions();
}
function libraryOptions() {return {el,btn,catalog:state.catalog,mechanics:state.mechanics,glossary:state.glossary,onAskGlossary:askGlossaryEntry,safeUrl,onEntity:(type,id)=>{
  if(type==='wisps'){const open=()=>{const entry=state.mechanics?.entries?.find(entry=>entry.id===id);if(entry)openMechanicDetail(entry);else toast('对应法杖图鉴暂未载入，请从赛季特殊玩法重读资料。',true);};if(state.mechanics)open();else loadMechanics().then(open);}
  else openEntity(type,id);
},onAsk:doc=>{closeModal();state.libraryDocumentId=doc.id;state.entityId=null;state.mechanicEntity=null;updateChatContext();renderSuggestions();showChat(true);$('#chat-input').value=`解释${doc.title.split(' · ')[0]}的触发条件与奖励规则。`;$('#chat-input').focus();}};}
function openLibraryDocument(doc) {
  const augment=doc.category==='augment'?doc.entities.find(ref=>ref.type==='augments'&&byId('augments',ref.id)):null;
  if(augment){navigate('augments');openEntity('augments',augment.id);return;}
  closeModal();navigate(Object.keys(LIBRARY_ROUTES).find(route=>LIBRARY_ROUTES[route]===doc.category) || 'library');
  selectLibraryDocument(doc);renderMain();
}
function appendLibraryKnowledge(body,type,id) {
  const slot=el('div',{class:'library-detail-slot'},el('p',{class:'library-inline-error',text:'正在读取奖励与机制细则…'}));body.append(slot);
  const append=snapshot=>{if(!slot.isConnected)return;slot.replaceChildren();if(snapshot.status!=='ready'){slot.append(el('p',{class:'library-inline-error',text:snapshot.reason || '中文机制资料尚未收录。'}));return;}
    const docs=entityDocuments(snapshot,id),rule=type==='augments'?snapshot.augmentRules.find(rule=>rule.id===id):null;
    if(rule)slot.append(createAugmentOffering(rule,snapshot.rulesSource,libraryOptions()));
    else if(type==='augments')slot.append(el('p',{class:'library-inline-error',text:'来源未提供此强化的出现规则，未借用其他强化或阶段变体。'}));
    for(const doc of docs)slot.append(createLibraryDocument(doc,libraryOptions()));
  };
  Promise.resolve(state.library || loadLibrary()).then(append);
}
let mechanicsRequest;
async function loadMechanics() {
  if (mechanicsRequest) return mechanicsRequest;
  state.mechanicsLoading = true;
  if (['mechanics','wisp-rules'].includes(state.view)) renderMain();
  mechanicsRequest = api('/api/mechanics').then(result => {state.mechanics=result;return result;})
    .catch(error => {state.mechanics={status:'error',entries:[],error:error.message};return state.mechanics;})
    .finally(() => {state.mechanicsLoading=false;mechanicsRequest=null;if(['mechanics','wisp-rules','library','guide'].includes(state.view))renderMain();});
  return mechanicsRequest;
}
function mechanicStages(entry) { return Array.isArray(entry.stages) ? entry.stages.map(String) : entry.stages == null ? [] : [String(entry.stages)]; }
const MECHANIC_STAGES = { Early: '前期', EarlyMid: '前中期', Mid: '中期', MidLate: '中后期', Late: '后期', VeryLate: '大后期' };
const MECHANIC_VARIANTS = { base: '基础', upgraded: '升级', prismatic: '棱彩' };
const MECHANIC_RATINGS = ['S', 'A', 'B', 'C', 'D'];
function mechanicCategory(value) { return state.mechanics?.mechanic?.categories?.find(category => category.id === value)?.name || state.mechanics?.entries?.find(entry => entry.category === value && entry.categoryName)?.categoryName || str(value === 'unknown' ? null : value, '未分类'); }
function mechanicRating(entry) { return entry.rating?.status === 'expert' && entry.rating.sourceKind === 'expert' && MECHANIC_RATINGS.includes(entry.rating.tier) ? entry.rating.tier : ''; }
function mechanicRatingBadge(entry) { const tier = mechanicRating(entry); return el('span', { class: tier ? `mechanic-rating-badge tier-${tier.toLowerCase()}` : 'tag neutral', title: tier ? 'Spencer 攻略评级，非胜率统计' : '该条目没有已核验评级', text: tier || '未评级' }); }
function mechanicRatingSource(source) {
  const url = safeUrl(source?.url);
  return el('div', { class: 'mechanic-expert-source' }, url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: `↗ ${source.name || 'MetaTFT · Spencer'}` }) : null, el('span', { text: source?.fetchedAt ? `采集 ${formatTime(source.fetchedAt)}` : '采集时间未提供' }));
}
function mechanicConditions(entry) {
  const original = Array.isArray(entry.conditions) ? entry.conditions.filter(value => typeof value === 'string') : typeof entry.conditions === 'string' && entry.conditions ? [entry.conditions] : [];
  const offering = Array.isArray(entry.offeringConditions?.conditionsText) ? entry.offeringConditions.conditionsText.filter(value => typeof value === 'string') : [];
  return [...new Set([...original, ...offering])];
}
function mechanicOfferingRecorded(entry) { return ['documented', 'partial'].includes(entry.offeringConditions?.status); }
function mechanicOfferingPatch(sources = []) { return [...new Set(sources.map(source => source.sourcePatch).filter(value => typeof value === 'string' && value))].join(' / '); }
function mechanicRoundWindows(windows) { return Array.isArray(windows) ? windows.filter(window => typeof window.from === 'string' && typeof window.to === 'string').map(window => `${window.from}–${window.to}`).join('；') : ''; }
function mechanicOfferingSources(sources = []) {
  const list = el('div', { class: 'mechanic-offering-sources' });
  sources.filter((source, index, all) => source?.url && all.findIndex(other => other.url === source.url) === index).forEach(source => {
    const url = safeUrl(source.url); if (!url) return;
    list.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: source.fetchedAt ? `采集 ${formatTime(source.fetchedAt)}` : '采集时间未提供', text: `↗ ${source.name || '条件来源'}${source.sourcePatch ? ` · ${source.sourcePatch}` : ''}` }));
  }); return list;
}
function renderMechanicOffering(entry) {
  const conditions = entry.offeringConditions;
  const recorded = mechanicOfferingRecorded(entry);
  const sources = Array.isArray(conditions?.sources) ? conditions.sources : [];
  const patch = mechanicOfferingPatch(sources);
  const section = el('section', { class: 'mechanic-offering' }, el('div', { class: 'mechanic-offering-heading' }, el('h3', { text: '出现条件' }), el('span', { class: `tag${recorded ? ' neutral' : ' gold'}`, text: recorded ? conditions.status === 'partial' ? '部分收录' : '已收录' : '未收录' }), patch ? el('span', { class: 'mechanic-offering-patch', text: `条件来源补丁 ${patch}` }) : null));
  if (!recorded) {
    section.append(el('p', { class: 'mechanic-offering-note', text: '当前条件表尚未收录此形态。购买费用、回合窗口与冷却保持未知，不继承其他形态的门槛。' }));
    return section;
  }
  const known = Array.isArray(conditions.conditionsText) ? conditions.conditionsText.filter(text => typeof text === 'string' && text) : [];
  section.append(el('p', { class: 'mechanic-offering-note', text: '以下为已知出现限制，符合条件仍不保证刷新出现。出现门槛与法杖效果触发分别核对。' }));
  if (known.length) section.append(el('ul', { class: 'mechanic-condition-list' }, known.map(text => el('li', { text }))));
  if (!conditions.sourceText) section.append(el('p', { class: 'mechanic-offering-note', text: '来源的特殊条件栏未列出额外文字，不代表没有费用、窗口、冷却或其他限制。' }));
  const facts = el('dl', { class: 'mechanic-offering-facts' });
  const fact = (label, value) => facts.append(el('dt', { text: label }), el('dd', { text: value }));
  const cost = conditions.purchaseConditions?.cost;
  fact(`购买费用${patch ? `（${patch}条件表）` : ''}`, cost?.unit === 'gold' && typeof cost.value === 'number' && Number.isFinite(cost.value) ? `${cost.value} 金币` : '未收录');
  fact('出现回合范围', mechanicRoundWindows(conditions.roundWindow) || '未收录');
  const cooldown = conditions.cooldown;
  fact('再次出现冷却', cooldown?.unit === 'wisp_shops' && cooldown.trigger === 'offered' && typeof cooldown.value === 'number' && Number.isFinite(cooldown.value) ? `被提供后 ${cooldown.value} 个法杖商店` : '未收录');
  if (conditions.modes) fact('模式', [['standard', '标准'], ['doubles', '双人']].map(([id, label]) => `${label}：${conditions.modes[id] === true ? '来源标记支持' : '来源未标支持'}`).join('；'));
  fact('候选权重', conditions.weight?.value == null ? '未提供' : `${str(conditions.weight.value)}（相对权重，非概率）`);
  fact('实际出现概率', '未知');
  section.append(facts, el('p', { class: 'mechanic-offering-note', text: '冷却从被提供时起计算，以法杖商店为单位。不同形态是否共用冷却未说明；未知权重不能换算实际概率。' }));
  const exclusions = Array.isArray(conditions.excludedBy) ? conditions.excludedBy : [];
  if (exclusions.length) section.append(el('div', { class: 'mechanic-offering-exclusions' }, el('h4', { text: '互斥强化' }), el('p', { class: 'mechanic-offering-note', text: '持有以下强化时，来源记录该法杖不会出现。' }), el('div', { class: 'actions' }, exclusions.map(augment => {
    const mapped = augment.catalogMapped && byId('augments', augment.id);
    const name = mapped?.name || (augment.name && augment.name !== augment.id ? augment.name : '强化名称未映射');
    return mapped ? btn(name, () => openEntity('augments', augment.id), 'secondary small') : el('span', { class: 'tag neutral', text: name });
  }))));
  const conflicts = Array.isArray(conditions.conflicts) ? conditions.conflicts : [];
  if (conflicts.length) {
    const differences = el('div', { class: 'mechanic-offering-conflicts' }, el('h4', { text: '来源差异与边界' }));
    conflicts.forEach(conflict => {
      if (conflict.reason) differences.append(el('p', { text: conflict.reason }));
      if (conflict.field === 'roundWindow') differences.append(el('p', { text: `Riot 官方窗口：${mechanicRoundWindows(conflict.riotValue) || '未说明'}。Little Buddy 窗口：${mechanicRoundWindows(conflict.littleBuddyValue) || '未说明'}。` }));
      if (conflict.field === 'purchaseCost') differences.append(el('p', { text: `Riot 官方费用：${str(conflict.riotValue)} 金币。Little Buddy 费用：${str(conflict.littleBuddyValue)} 金币。` }));
    }); section.append(differences);
  }
  if (conditions.sourceText) section.append(el('details', { class: 'mechanic-offering-original' }, el('summary', { text: '查看条件来源原文' }), el('p', { text: conditions.sourceText })));
  section.append(mechanicOfferingSources(sources));
  return section;
}
function renderMechanicOfferingOverview(result) {
  const offering = result.offering;
  const coverage = offering?.coverage;
  const sources = Array.isArray(offering?.sources) ? offering.sources : [];
  const patch = mechanicOfferingPatch(sources);
  const section = el('section', { class: 'mechanic-offering-overview' }, el('div', { class: 'mechanic-offering-heading' }, el('h3', { text: `出现条件${patch ? ` · 来源补丁 ${patch}` : ''}` }), el('span', { class: 'tag neutral', text: offering?.status === 'cached' && coverage ? `已收录 ${coverage.mapped} / ${coverage.currentEntities}` : '尚未收录' })), el('p', { class: 'mechanic-offering-note', text: '满足已知限制不保证刷新出现，权重与实际概率未知。条件来源的补丁与效果说明、攻略评级分别核对。' }));
  const rules = Array.isArray(offering?.rules) ? offering.rules.filter(rule => typeof rule.text === 'string') : [];
  if (rules.length) section.append(el('details', { class: 'mechanic-offering-rules' }, el('summary', { text: '查看通用出现规则' }), el('ul', { class: 'mechanic-condition-list' }, rules.map(rule => el('li', { text: rule.text }))), mechanicOfferingSources(sources)));
  return section;
}
function mechanicTags(entry) {
  return el('div', { class: 'mechanic-tags' }, el('span', { class: 'tag neutral', text: entry.categoryName || mechanicCategory(entry.category) }), entry.upgrade?.variant && MECHANIC_VARIANTS[entry.upgrade.variant] ? el('span', { class: 'tag neutral', text: MECHANIC_VARIANTS[entry.upgrade.variant] }) : null, entry.cost != null ? el('span', { class: 'tag gold', text: `图鉴 ${entry.cost} 金币` }) : null, mechanicStages(entry).length ? el('span', { class: 'tag neutral', text: mechanicStages(entry).map(stage => MECHANIC_STAGES[stage] || stage).join(' / ') }) : null, entry.availability?.status === 'unverified' ? el('span', { class: 'tag gold', text: mechanicOfferingRecorded(entry) ? '原图鉴资料待补' : '可获得性待核验' }) : null, el('span', { class: `tag${mechanicOfferingRecorded(entry) ? ' neutral' : ' gold'}`, text: mechanicOfferingRecorded(entry) ? entry.offeringConditions.status === 'partial' ? '出现条件部分收录' : '出现条件已收录' : '出现条件未收录' }));
}
function mechanicSources(entry) {
  const source = entry?.source || state.mechanics?.source;
  const fieldSources = source && !Array.isArray(source) ? ['descriptionSource', 'metadataSource'].map(key => source[key]).filter(value => value && typeof value === 'object' && value.url) : [];
  const entries = fieldSources.length ? fieldSources.filter((value, index, all) => all.findIndex(other => other.url === value.url) === index) : Array.isArray(source) ? source : source ? [source] : [];
  const links = el('div', { class: 'mechanic-sources' });
  entries.forEach(value => {
    const source = typeof value === 'string' ? { url: value } : value;
    const url = safeUrl(source.url || source.endpoint);
    links.append(url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: `↗ ${source.name || source.title || '资料来源'}` }) : el('span', { text: source.name || source.title || '资料来源' }));
  }); return links;
}
function selectMechanic(entry) {
  state.mechanicsSelectedId = entry.id; state.entityId = entry.id; state.statEntity = null; state.libraryDocumentId=null;state.mechanicEntity = { kind: 'wisp', id: entry.id }; updateChatContext();
  document.querySelectorAll('.mechanic-card').forEach(card => card.classList.toggle('selected', card.dataset.mechanicId === entry.id));
}
function askMechanic(entry) {
  selectMechanic(entry); closeModal(); showChat(true);
  $('#chat-input').value = `给我${entry.name || '这个法杖'}的玩法和适合阵容，直接列队友、装备与变阵步骤。`;
  $('#chat-input').focus();
}
function openMechanicDetail(entry) {
  selectMechanic(entry);
  const body = el('div', { class: 'mechanic-detail' }, el('div', { class: 'mechanic-detail-heading' }, entityImage(entry), el('div', {}, el('h3', { text: entityName(entry) }), entry.nameEn ? el('small', { text: entry.nameEn }) : null)), mechanicTags(entry), renderMechanicOffering(entry), el('section', { class: 'mechanic-effect' }, el('h3', { text: '效果与触发' }), el('p', { class: 'mechanic-description', text: readableDescription(entry.description, '来源尚未提供该法杖的效果说明。') })));
  const conditions = Array.isArray(entry.conditions) ? entry.conditions.filter(text => typeof text === 'string') : [];
  if (conditions.length) body.append(el('section', { class: 'modal-section' }, el('h3', { text: '图鉴补充限制' }), el('ul', { class: 'mechanic-condition-list' }, conditions.map(condition => el('li', { text: condition })))));
  const related = entry.upgrade ? [['基础法杖', entry.upgrade.baseId], ['升级法杖', entry.upgrade.upgradedId], ['棱彩法杖', entry.upgrade.prismaticId]].map(([label, id]) => [label, state.mechanics.entries.find(candidate => candidate.id === id)]).filter(([, candidate]) => candidate && candidate.id !== entry.id) : [];
  if (related.length) body.append(el('section', { class: 'modal-section' }, el('h3', { text: '查看关联形态' }), el('div', { class: 'actions', style: { marginTop: '9px' } }, related.map(([label, candidate]) => btn(label, () => openMechanicDetail(candidate), 'secondary small')))));
  const tier = mechanicRating(entry);
  body.append(el('div', { class: 'mechanic-detail-rating' }, mechanicRatingBadge(entry), el('span', { text: tier ? 'Spencer 攻略评级 · 非胜率统计' : '该形态攻略评级暂未录入' })));
  if (tier) body.append(mechanicRatingSource(entry.rating.source || state.mechanics.rating?.source));
  if (entry.cost == null || !mechanicStages(entry).length) body.append(el('p', { class: 'mechanic-unrated-note', text: [entry.cost == null ? '图鉴费用未提供' : '', !mechanicStages(entry).length ? '图鉴阶段未提供' : ''].filter(Boolean).join(' · ') }));
  if (entry.availability?.status === 'unverified') body.append(el('p', { class: 'mechanic-unrated-note', text: mechanicOfferingRecorded(entry) ? '原图鉴仅静态收录；费用和回合窗口已由以上18.4条件表独立补充。' : '仅静态资料收录，当前可获得性尚未核验。' }));
  body.append(el('div', { class: 'actions', style: { marginTop: '16px' } }, btn('✧ 问助理：玩法与阵容', () => askMechanic(entry), 'primary')), mechanicSources(entry));
  openModal('法杖详情', body);
  appendLibraryKnowledge(body,'wisps',entry.id);
}
function renderMechanics(main) {
  const result = state.mechanics;
  const section = state.view === 'wisp-rules' ? 'rules' : state.mechanicsSection;
  const showConditions = section === 'conditions';
  main.append(guideNav(), heading('PLAY THE SEASON', '赛季特殊玩法', '法杖出现条件、效果与机制细则，收在同一个入口。', [btn(state.mechanicsLoading ? '读取中…' : '↻ 重读玩法资料', loadMechanics, 'ghost', state.mechanicsLoading)]));
  main.append(el('div', { class: 'mechanic-section-nav', role:'group', 'aria-label':'赛季玩法栏目' }, [['conditions','法杖出现条件'],['catalog','法杖图鉴'],['rules','机制细则']].map(([id,label])=>el('button', {type:'button',class:section===id?'active':'','aria-pressed':String(section===id),onclick:()=>{
    state.mechanicsSection=id;state.mechanicsPage=1;state.view='mechanics';const url=new URL(location.href);url.hash='mechanics';history.replaceState(null,'',url);renderNav();renderMain();updateChatContext();renderSuggestions();
  }},label))));
  if(section==='rules') {
    renderLibraryBrowser(main,{...libraryOptions(),snapshot:state.library,category:'wisp',selectedId:state.libraryDocumentId,onSelect:selectLibraryDocument,onNavigate:navigate});
    return;
  }
  if (state.mechanicsLoading) return main.append(el('div', { class: 'stats-loading' }, el('span', { class: 'spinner' }), el('p', { text: '正在读取赛季玩法资料…' })));
  if (!result || result.status !== 'cached' || !Array.isArray(result.entries)) return main.append(empty(result?.error ? '赛季玩法资料读取未完成' : '赛季玩法资料尚未收录', str(result?.reason || result?.error, '当前没有可展示的玩法条目。'), [btn('重新读取', loadMechanics, 'secondary')], '❋'));
  const entries = result.entries;
  const rules = Array.isArray(result.mechanic?.rules) ? result.mechanic.rules.filter(rule => typeof rule === 'string') : [];
  const introduction = el('section', { class: 'mechanics-introduction' }, el('div', { class: 'mechanics-title-row' }, el('span', { class: 'mechanics-symbol', 'aria-hidden': 'true', text: '❋' }), el('div', {}, el('span', { class: 'eyebrow', text: `SET ${result.mechanic?.set || result.context?.set || '—'}` }), el('h2', { text: result.mechanic?.name || '法杖' })), el('span', { class: 'tag neutral', text: `${entries.length} 个法杖 / 变体` })));
  if (rules.length) {
    const rulesBody = el('details', { class: 'mechanics-rules' }, el('summary', { text: '玩法规则' }), el('ul', {}, rules.map(rule => el('li', { text: rule }))));
    const upgradeRules = result.mechanic?.upgradeRules?.filter(rule => typeof rule.description === 'string') || [];
    if (upgradeRules.length) rulesBody.append(el('h3', { class: 'mechanics-upgrade-title', text: '灵魂莲华与法杖升级' }), el('ul', {}, upgradeRules.map(rule => el('li', { text: rule.description }))));
    if (result.rulesSource || result.mechanic?.rulesSource) rulesBody.append(mechanicSources({ source: result.rulesSource || result.mechanic.rulesSource }));
    introduction.append(rulesBody);
  }
  const hasRatings = entries.some(entry => mechanicRating(entry));
  if(!showConditions) main.append(introduction, el('div', { class: 'mechanics-rating-note' }, el('strong', { text: hasRatings ? 'Spencer 攻略评级 · 非胜率统计' : '攻略评级暂未录入' }), el('span', { text: hasRatings ? '基础法杖按实际榜单标档；未核验的形态保持未评级。' : result.rating?.reason || '当前条目均保持未评级。' })));
  if (!showConditions && hasRatings) main.append(mechanicRatingSource(result.rating?.source));
  const ratingMethod = el('details', { class: 'mechanics-rating-method' }, el('summary', { text: 'S / A / B / C / D 如何使用' }), el('p', { text: '档位是攻略中的相对推荐；选择时仍需结合阵容、阶段与已有资源。' }), el('div', { class: 'mechanics-rating-scale' }, [['S', '优先研究'], ['A', '较推荐'], ['B', '看阵容选择'], ['C', '条件较苛刻'], ['D', '谨慎选择']].map(([grade, meaning]) => el('div', {}, el('b', { text: grade }), el('span', { text: meaning })))));
  if(!showConditions)main.append(ratingMethod);
  main.append(renderMechanicOfferingOverview(result));
  const filter = state.mechanicsFilter;
  const grid = el('div', { class: 'mechanics-grid' }); const count = el('p', { class: 'mechanics-results-count', role: 'status' }); const pagination = el('div', { class: 'stats-pagination' });
  const filterChanged = () => { state.mechanicsPage = 1; updateEntries(); };
  const search = el('input', { type: 'search', placeholder: '搜索法杖名称、效果或条件…', 'aria-label': '搜索法杖', value: filter.search, oninput: event => { filter.search = event.target.value; filterChanged(); } });
  const categories = [...new Set(entries.map(entry => entry.category || 'unknown'))];
  const stageOrder = Object.keys(MECHANIC_STAGES); const stages = [...new Set(entries.flatMap(mechanicStages))].sort((a, b) => stageOrder.indexOf(a) - stageOrder.indexOf(b));
  const category = el('select', { 'aria-label': '法杖分类', onchange: event => { filter.category = event.target.value; filterChanged(); } }, el('option', { value: '', text: '全部分类' }), categories.map(value => el('option', { value, selected: value === filter.category, text: mechanicCategory(value) })));
  const stage = el('select', { 'aria-label': '法杖图鉴阶段', onchange: event => { filter.stage = event.target.value; filterChanged(); } }, el('option', { value: '', text: '全部图鉴阶段' }), stages.map(value => el('option', { value, selected: value === filter.stage, text: MECHANIC_STAGES[value] || value })));
  const rating = el('select', { 'aria-label': '法杖攻略评级', onchange: event => { filter.rating = event.target.value; filterChanged(); } }, el('option', { value: '', text: '全部评级' }), [...MECHANIC_RATINGS.filter(tier => entries.some(entry => mechanicRating(entry) === tier)), ...(entries.some(entry => !mechanicRating(entry)) ? ['unrated'] : [])].map(tier => el('option', { value: tier, selected: tier === filter.rating, text: tier === 'unrated' ? '未评级' : `${tier} 级` })));
  const variants = [...new Set(entries.map(entry => entry.upgrade?.variant).filter(Boolean))];
  const variant = el('select', { 'aria-label': '法杖形态', onchange: event => { filter.variant = event.target.value; filterChanged(); } }, el('option', { value: '', text: '全部形态' }), variants.map(value => el('option', { value, selected: value === filter.variant, text: MECHANIC_VARIANTS[value] || value })));
  const rounds = Array.from({length:9},(_,index)=>index+2).flatMap(stage=>Array.from({length:stage===10?1:7},(_,index)=>`${stage}-${index+1}`));
  const round = el('select', {'aria-label':'查询法杖出现回合',onchange:event=>{filter.round=event.target.value;filterChanged();}},el('option',{value:'',text:'全部出现回合'}),rounds.map(value=>el('option',{value,selected:value===filter.round,text:`回合 ${value}`})));
  const coverage = el('select', {'aria-label':'法杖条件收录状态',onchange:event=>{filter.coverage=event.target.value;filterChanged();}},[['','全部收录状态'],['recorded','条件已收录'],['unknown','条件未收录']].map(([value,text])=>el('option',{value,text,selected:value===filter.coverage})));
  main.append(el('div', { class: 'mechanics-filters' }, search, category, showConditions?round:stage, showConditions?coverage:rating, variant), el('p', { class: 'mechanics-filter-note', text: showConditions?'按已收录的回合窗口筛选；有来源差异的边界保留提示，未知窗口不参与回合筛选。点开卡片查看冷却、模式与互斥强化。':'图鉴阶段与攻略评级供参考，精确出现回合请查看“法杖出现条件”。' }), count, grid, pagination, mechanicSources());
  function updateEntries() {
    const ratingOrder = entry => { const tier = mechanicRating(entry); return tier ? MECHANIC_RATINGS.indexOf(tier) : 5; };
    const search = filter.search.normalize('NFKC').toLowerCase().replace(/\s/g, '');
    const matched = entries.filter(entry => (!filter.category || (entry.category || 'unknown') === filter.category)
      && (showConditions ? (!filter.round || ['inside','conflict'].includes(offeringWindowAt(entry,filter.round))) && (!filter.coverage || offeringPreview(entry).recorded === (filter.coverage==='recorded')) : (!filter.stage || mechanicStages(entry).includes(filter.stage)) && (!filter.rating || (mechanicRating(entry) || 'unrated') === filter.rating))
      && (!filter.variant || entry.upgrade?.variant === filter.variant) && mechanicSearchText(entry).includes(search))
      .sort((a, b) => (showConditions?0:ratingOrder(a) - ratingOrder(b)) || (a.name || '').localeCompare(b.name || '', 'zh-CN'));
    count.textContent = `${matched.length} / ${entries.length} 个法杖 / 变体`;
    const pages = Math.max(1, Math.ceil(matched.length / 30)); state.mechanicsPage = Math.max(1, Math.min(pages, state.mechanicsPage));
    grid.replaceChildren(...matched.slice((state.mechanicsPage - 1) * 30, state.mechanicsPage * 30).map(entry => {
      const preview=offeringPreview(entry),special=preview.conditions.filter(text=>!/^当前.*费用.*只有买得起/.test(text));
      const facts=showConditions?el('div',{class:'mechanic-card-conditions'},el('div',{class:'mechanic-card-window'},el('small',{text:'出现回合'}),el('strong',{text:preview.window})),el('div',{class:'mechanic-card-cost'},el('span',{text:preview.cost==null?'费用未收录':`${preview.cost} 金币`}),el('span',{text:preview.cooldown==null?'冷却未收录':`再次出现：${preview.cooldown} 次法杖商店后`})),
        el('p',{text:special.slice(0,2).join('；') || '未列额外特殊条件，仍受费用、回合与冷却限制。'}),special.length>2?el('small',{text:`另有 ${special.length-2} 条条件，点击查看完整内容`}):null,
        entry.offeringConditions?.conflicts?.length?el('span',{class:'tag gold',text:'存在来源差异 · 详情可核对'}):null):null;
      return el('article', { class: `mechanic-card${showConditions?' mechanic-conditions-card':''}${state.mechanicsSelectedId === entry.id ? ' selected' : ''}`, 'data-mechanic-id': entry.id },
        el('button', { type: 'button', class: 'mechanic-card-main', onclick: () => openMechanicDetail(entry), 'aria-label': `查看${entityName(entry)}详情` }, el('div', { class: 'mechanic-card-heading' }, entityImage(entry), el('h3', { text: entityName(entry) })),
          showConditions?el('div',{class:'mechanic-tags'},el('span',{class:'tag neutral',text:MECHANIC_VARIANTS[entry.upgrade?.variant] || '法杖'}),el('span',{class:`tag ${preview.recorded?'neutral':'gold'}`,text:preview.recorded?'条件已收录':'条件未收录'})):mechanicTags(entry),facts,
          el('p', { class:'mechanic-card-effect-preview',text: readableDescription(entry.description, '效果说明尚未收录') })),
        el('div', { class: 'mechanic-card-footer' }, showConditions?btn('查看出现条件 →',()=>openMechanicDetail(entry),'ghost small'):mechanicRatingBadge(entry), btn('✧ 问玩法', () => askMechanic(entry), 'ghost small')));
    }));
    pagination.replaceChildren(...(matched.length ? [el('span', { text: `第 ${state.mechanicsPage} / ${pages} 页 · 每页最多 30 条` }), el('div', { class: 'actions' }, btn('← 上一页', () => { state.mechanicsPage -= 1; updateEntries(); }, 'ghost small', state.mechanicsPage <= 1), btn('下一页 →', () => { state.mechanicsPage += 1; updateEntries(); }, 'ghost small', state.mechanicsPage >= pages))] : []));
    if (!matched.length) grid.append(empty('没有匹配的法杖', '调整搜索词、分类或阶段。', [], '⌕'));
  } updateEntries();
}
function statsControls(tab, onChange, placeholder = '搜索名称…') {
  const filter = state.statsFilters[tab];
  return el('div', { class: 'stats-controls' }, el('input', { type: 'search', placeholder, value: filter.search, 'aria-label': '搜索缓存记录', oninput: event => { filter.search = event.target.value; onChange(); } }), el('label', { class: 'stats-sample-field' }, '最低样本', el('input', { type: 'number', min: 0, value: filter.minSample, 'aria-label': '最低样本数量', oninput: event => { filter.minSample = Math.max(0, Math.floor(Number(event.target.value) || 0)); onChange(); } })));
}
function filterStatRows(rows, tab, searchable) {
  const filter = state.statsFilters[tab];
  const metric = row => row.stats || row.stat?.deck || row.stat || {};
  return rows.filter(row => searchable(row).toLowerCase().includes(filter.search.trim().toLowerCase()) && (!filter.minSample || Number.isFinite(metric(row).sampleSize) && metric(row).sampleSize >= filter.minSample)).sort((a, b) => {
    const av = metric(a)[filter.sort], bv = metric(b)[filter.sort];
    if (!Number.isFinite(av)) return Number.isFinite(bv) ? 1 : 0;
    if (!Number.isFinite(bv)) return -1;
    return filter.sort === 'avgPlacement' ? av - bv : bv - av;
  });
}
function cacheContext(result) {
  const evidence = Array.isArray(result?.evidence) ? result.evidence[0] || {} : result?.evidence || {};
  return el('div', { class: 'stats-cache-context' }, el('span', { class: 'tag', text: '当前版本缓存' }), el('span', { class: 'tag gold', text: `统计补丁 ${patchContext(evidence).label}` }), el('span', { text: `源时间 ${evidence.sourceTime ? formatTime(evidence.sourceTime) : '未知'} · 采集 ${evidence.fetchedAt ? formatTime(evidence.fetchedAt) : '未知'}` }));
}
function getExplorerState() {
  if (!state.explorer) state.explorer = { ...normalizeExplorerQuery({ mode: 'builds', tab: 'champions' }), selectedRow: null, results: {}, loading: {}, conditionTarget: 'include', conditionType: '' };
  state.explorer.results ||= {}; state.explorer.loading ||= {};
  return state.explorer;
}
function readExplorerQueryFromUrl() {
  const value = new URL(location.href).searchParams.get('explorer');
  if (value == null) return;
  const query = decodeExplorerQuery(value);
  if (!query) return;
  const current = getExplorerState();
  Object.assign(current, query, { mode: query.mode || null, selectedRow: null }); state.statsTab = query.tab;
  state.statEntity = null; state.entityId = null;
}
function explorerIndex() {
  if (state.explorerSearchCatalog !== state.catalog) { state.explorerSearchCatalog = state.catalog; state.explorerSearchIndex = buildExplorerIndex(state.catalog); }
  return state.explorerSearchIndex;
}
function explorerEntity(type, id) { return byId({ champion: 'champions', item: 'items', trait: 'traits' }[type], id); }
function explorerNumber(value, rate = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return rate ? `${(value * 100).toFixed(1)}%` : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
function explorerScope(tab, evidence = {}) {
  const scope = `${evidence.queue || evidence.population?.queue || '队列未知'} / ${evidence.rank || evidence.population?.rank || '段位未知'} · 来源补丁 ${evidence.sourcePatch || '未知'}`;
  return ({ units: `英雄整体记录 · ${scope}。联合条件需切换到组合记录。`, equipment: `装备整体记录 · ${scope}。未提供英雄与装备的联合样本。`, items: '英雄 × 装备携带记录；不是英雄或装备的整体胜率。', champions: '英雄 × 三件套记录；不是英雄的整体胜率。', decks: '来源阵容样本；“变阵”用于研究阵容，不提供转型过程胜率。', traits: `羁绊档位记录 · ${scope}。`, emblems: '转职携带者记录；已排除原生拥有对应羁绊的英雄。' })[tab];
}
function syncExplorerContext(row = null) {
  const query = getExplorerState(); query.selectedRow = row;
  state.statEntity = null; state.mechanicEntity = null;
  if (row?.kind === 'emblem_holder') {
    state.entityId = row.itemId; state.statEntity = { kind: 'emblem', itemId: row.itemId, championId: row.championId };
    state.emblemResearchChampionId = row.championId; state.statsSelections.emblems = row.itemId;
  } else if (row) {
    state.entityId = row.traitId || (query.perspective === 'item' || row.kind === 'item_overall' ? row.itemId : row.championId) || row.unitIds?.[0] || null;
    if (row.championId) state.statsSelections.champions = row.championId;
    if (row.itemId) state.statsSelections.items = row.itemId;
  } else {
    const last = query.include.at(-1); state.entityId = last?.id || null;
    if (query.tab === 'emblems' && last?.type === 'item' && explorerEntity('item', last.id)?.category === 'emblem') state.statsSelections.emblems = last.id;
  }
  updateChatContext(); renderSuggestions();
}
function addExplorerCondition(type, id, target = null) {
  if (!explorerEntity(type, id)) return;
  const query = getExplorerState(); const field = target || query.conditionTarget || 'include';
  if (query[field].some(condition => condition.type === type && condition.id === id)) return;
  if (query[field].length >= 24) return toast('每组最多添加 24 个条件。');
  query[field].push({ type, id }); query.page = 1;
  state.emblemResearchChampionId = ''; syncExplorerContext();
}
function explorerShareUrl() {
  const url = new URL(location.href); url.hash = 'stats'; url.searchParams.set('explorer', encodeExplorerQuery(getExplorerState())); return url;
}
function saveExplorerQuery() { history.replaceState(null, '', explorerShareUrl()); toast('查询已保存到当前地址，可用书签保留。'); }
async function shareExplorerQuery() {
  const url = explorerShareUrl().href;
  try { await navigator.clipboard.writeText(url); toast('查询链接已复制。'); }
  catch { openModal('复制查询链接', el('div', {}, el('p', { class: 'modal-description', text: '链接包含当前条件，不包含聊天记录。接收方需要能访问本应用。' }), el('textarea', { class: 'modal-form-input', rows: 5, readonly: true, value: url, 'aria-label': '查询链接', onfocus: event => event.target.select() }))); }
}
function explorerSettings(onChange) {
  const query = getExplorerState();
  const minimum = el('input', { type: 'number', min: 0, max: 100000000, value: query.minSample, class: 'modal-form-input', 'aria-label': '自定义最低样本数' });
  const sort = el('select', { class: 'modal-form-input', 'aria-label': '默认排序' }, [['avgPlacement', '平均名次 · 从低到高'], ['sampleSize', '样本数 · 从高到低'], ['top4Rate', '前四率 · 从高到低'], ['winRate', '登顶率 · 从高到低']].map(([value, name]) => el('option', { value, selected: query.sort === value, text: name })));
  openModal('检索设置', el('div', {}, el('label', { class: 'modal-form-label', text: '最低样本数（0 显示全部，包括样本未知的记录）' }), minimum, el('label', { class: 'modal-form-label', text: '排序指标' }), sort, el('div', { class: 'actions' }, btn('应用设置', () => { Object.assign(query, normalizeExplorerQuery({ ...query, minSample: minimum.value, sort: sort.value, sortDirection: sort.value === 'avgPlacement' ? 'asc' : 'desc', page: 1 })); closeModal(); onChange(); }, 'primary'))));
}
function readResearchQueryFromUrl() {
  const url = new URL(location.href);
  try {
    if (url.searchParams.has('research')) { state.research = normalizeResearchQuery(JSON.parse(url.searchParams.get('research'))); if(!url.searchParams.has('rank')&&state.research.rank)savePageRank(state.research.rank); }
    else if (url.searchParams.has('explorer')) state.research = researchFromLegacy(JSON.parse(url.searchParams.get('explorer')));
  } catch { state.research = normalizeResearchQuery(); }
}
function saveResearchQuery() {
  const url = new URL(location.href); url.searchParams.delete('explorer');
  if(state.research.rank)url.searchParams.set('rank',state.research.rank);
  if (state.research.conditions.length || state.research.rank) url.searchParams.set('research', JSON.stringify(normalizeResearchQuery(state.research)));
  else url.searchParams.delete('research');
  history.replaceState(null, '', url);
}
function openResearch(conditions) {
  state.research = normalizeResearchQuery({ conditions,rank:pageRank() }); saveResearchQuery(); navigate('explorer');
}
function renderStats(main) {
  state.explorer = null;
  renderStatsBrowser(main, { catalog: state.catalog, api, onQuery: openResearch,
    onSelect: entity => { state.entityId = entity?.id || null; state.statsTab = entity?.type === 'champion' ? 'units' : 'equipment'; updateChatContext(); renderSuggestions(); }
  });
}
function explorerRowTitle(row) {
  if (row.kind === 'trait_tier') return `${row.name} · ${row.threshold ?? '未知'}人档`;
  if (['champion_overall', 'item_overall'].includes(row.kind)) return row.name;
  const items = (row.itemIds || []).map(id => byId('items', id)?.name).filter(Boolean).join(' / ');
  return `${row.name || '未命名记录'}${items ? ` · ${items}` : ''}`;
}
function explorerRowCell(row, query) {
  const box = el('div', { class: 'explorer-record-entity' });
  if (row.kind === 'item_overall') return el('div', { class: 'explorer-record-entity' }, entityImage(byId('items', row.itemId) || row), el('strong', { text: row.name }));
  if (row.kind === 'champion_overall') {
    const champion = byId('champions', row.championId) || row;
    return el('div', { class: 'explorer-record-entity' }, entityImage(champion), el('div', {}, el('strong', { text: row.name }), el('small', { text: `${champion.cost || '?'} 费 · ${(champion.traits || []).join(' / ')}` })));
  }
  if (row.kind === 'trait_tier') return el('div', { class: 'explorer-record-entity' }, entityImage(byId('traits', row.traitId) || row), el('div', {}, el('strong', { text: row.name }), el('small', { text: `${row.threshold ?? '未知'} 人档` })));
  if (row.kind === 'deck') return el('div', { class: 'explorer-record-deck' }, el('strong', { text: row.name }), el('div', { class: 'explorer-team-icons' }, (row.unitIds || []).map(id => el('span', { title: byId('champions', id)?.name }, entityImage(byId('champions', id))))));
  const champion = byId('champions', row.championId) || row;
  const items = (row.itemIds || []).map(id => byId('items', id)).filter(Boolean);
  if (query.perspective === 'item' && row.kind !== 'champion_build') {
    const item = items[0]; box.append(entityImage(item), el('div', {}, el('strong', { text: item?.name || row.itemName || '未识别装备' }), el('small', { text: `${champion.name} · ${champion.cost || '?'} 费` })), el('span', { class: 'explorer-holder-icon', title: champion.name }, entityImage(champion)));
  } else box.append(entityImage(champion), el('div', {}, el('strong', { text: champion.name }), el('small', { text: `${champion.cost || '?'} 费` })), el('div', { class: 'explorer-row-item-icons' }, items.map(item => el('span', { title: item.name }, entityImage(item)))));
  return box;
}
function changeStatsTab(tab) {
  const query = getExplorerState(); const target = tab;
  if (!['units', 'equipment', 'items', 'traits', 'champions', 'decks', 'emblems'].includes(target)) return;
  query.tab = target; query.perspective = tab === 'equipment' ? 'item' : 'champion'; query.page = 1;
  if (['traits', 'equipment'].includes(target)) query.cost = '';
  state.statsTab = target; state.emblemResearchChampionId = ''; syncExplorerContext(); renderMain();
}
async function loadExplorerRows(tab, force = false) {
  const query = getExplorerState(); if (query.loading[tab] || !force && query.results[tab]) return;
  query.loading[tab] = true;
  try { query.results[tab] = await api(`/api/explorer?tab=${encodeURIComponent(tab)}`, undefined, 60000); }
  catch (error) { query.results[tab] = { status: 'unavailable', rows: [], reason: error.message }; }
  finally {
    query.loading[tab] = false;
    if (state.view === 'stats' && query.tab === tab) {
      const input = document.activeElement; const restoreFocus = input?.id === 'explorer-condition-search';
      const selection = restoreFocus ? [input.selectionStart, input.selectionEnd] : null;
      renderMain();
      if (restoreFocus) { const replacement = $('#explorer-condition-search'); replacement?.focus({ preventScroll: true }); if (replacement && selection[0] != null) replacement.setSelectionRange(...selection); }
    }
  }
}
async function loadStatsOverview() {
  if (state.statsLoading) return;
  state.statsLoading = true;
  try { state.statsOverview = await api('/api/stats'); }
  catch (error) { state.statsError = error.message; }
  finally { state.statsLoading = false; }
}
function emblemTraitName(item) { return byId('traits', item?.traitId)?.name || item?.traitName || ''; }
function isNativeEmblemHolder(item, champion) {
  if (item?.category !== 'emblem' || !Array.isArray(champion?.traits)) return false;
  const traitName = emblemTraitName(item); return champion.traits.some(trait => trait === item.traitId || traitName && trait === traitName);
}
function askEmblemRoster(itemId, championId) {
  const item = byId('items', itemId); const champion = byId('champions', championId);
  if (item?.category !== 'emblem' || !champion) return toast('当前目录无法识别这枚转职或这名英雄。', true);
  if (isNativeEmblemHolder(item, champion)) return toast(`${champion.name}已原生拥有${emblemTraitName(item) || '该羁绊'}，请选择其他携带者。`, true);
  const query = getExplorerState();
  if (query.selectedRow?.championId !== championId || query.selectedRow?.itemId !== itemId) query.selectedRow = null;
  state.entityId = itemId; state.statEntity = { kind: 'emblem', itemId, championId }; state.emblemResearchChampionId = championId;
  const chooser = $('#emblem-research-champion'); if (chooser) chooser.value = championId;
  showChat(true); updateChatContext(); $('#chat-input').value = `请给我由${champion.name}携带${item.name}的推荐阵容，直接列队友和装备。`; $('#chat-input').focus();
}
function emblemResearchPicker(itemId) {
  const item = byId('items', itemId); const champions = state.catalog.champions.filter(champion => !isNativeEmblemHolder(item, champion));
  const select = el('select', { id: 'emblem-research-champion', 'aria-label': '手动选择携带转职的英雄', onchange: event => { getExplorerState().selectedRow = null; state.emblemResearchChampionId = event.target.value; state.statEntity = event.target.value ? { kind: 'emblem', itemId, championId: event.target.value } : null; state.entityId = itemId; updateChatContext(); } }, el('option', { value: '', text: '选择携带这枚转职的英雄…' }), champions.map(champion => el('option', { value: champion.id, selected: champion.id === state.emblemResearchChampionId, text: `${champion.name}${champion.cost ? ` · ${champion.cost}费` : ''}` })));
  return el('section', { class: 'emblem-research-picker' }, el('h3', { text: '指定英雄，研究转职阵容' }), el('p', { text: '排除原生拥有该羁绊的英雄。缺少真实阵容证据时，TFT助手会标注模拟。' }), el('div', { class: 'emblem-research-controls' }, select, btn('问TFT助手：转职阵容', () => { if (!select.value) return toast('先选择一名携带转职的英雄。'); askEmblemRoster(itemId, select.value); }, 'secondary')));
}

function empty(title, description, actions = [], symbol = '◇') {
  return el('div', { class: 'empty-state' }, el('div', { class: 'empty-symbol', 'aria-hidden': 'true', text: symbol }), el('h2', { text: title }), el('p', { text: description }), actions.length ? el('div', { class: 'actions' }, actions) : null);
}
function counter(value, label, onChange, minimum = 0, maximum = 99) {
  const input = el('input', { type: 'number', min: minimum, max: maximum, value, 'aria-label': label, onchange: event => onChange(Math.max(minimum, Math.min(maximum, number(event.target.value)))) });
  return el('div', { class: 'counter' }, el('button', { type: 'button', 'aria-label': `减少${label}`, disabled: value <= minimum, onclick: () => onChange(Math.max(minimum, value - 1)) }, '−'), input, el('button', { type: 'button', 'aria-label': `增加${label}`, disabled: value >= maximum, onclick: () => onChange(Math.min(maximum, value + 1)) }, '+'));
}
function panelHeader(step, title, sub, actions) {
  return el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, el('span', { class: 'step-number', text: step }), el('h2', { text: title }), sub ? el('small', { text: sub }) : null), actions);
}
function renderWorkbench(main) {
  main.append(heading('YOUR NEXT DECISION', '让装备，成就整个队伍', '把棋子、已有资源与保留条件放在一起，得到可以逐件核对的分配方案。', [
    btn('+ 添加棋子', () => picker('champions', addChampion), 'secondary', !state.catalog.champions.length)
  ]));
  main.append(el('div', { class: 'intro-strip' }, el('span', { class: 'intro-symbol', 'aria-hidden': 'true', text: '✦' }), el('div', {}, el('strong', { text: '全队规划，从你手里的资源开始' }), el('p', { text: '锁装 · 棋子优先级 · 资源预留 · 合成检查，一份草案持续修改。' })), el('span', { class: 'tag', text: '确定性资源校验' })));
  if (state.catalogError) main.append(el('div', { class: 'error-box', text: `资料库加载失败：${state.catalogError}` }));
  if (draftContextBlocked()) main.append(el('div', { class: 'warning-box' }, el('strong', { text: '自动恢复草案的资源或规则版本已改变' }), el('p', { text: `草案上下文：${state.draftContextKey}。旧草案保留可查看；跨版本草案暂不可编辑、规划或用于证据问答。` }), el('div', { class: 'actions', style: { marginTop: '10px' } }, btn('新建当前版本草案', resetDraftForContext, 'secondary small'))));
  if (catalogMissing(state.draft)) main.append(el('div', { class: 'warning-box' }, el('strong', { text: '草案包含当前资源包中不存在的实体' }), el('p', { text: '请删除未识别棋子或装备后重新规划。旧版本资源不会自动混入当前版本。' })));
  const grid = el('div', { class: 'workbench-grid' });
  const teamPanel = el('section', { class: 'panel team-panel', 'aria-labelledby': 'team-title' });
  const teamHeader = panelHeader('01', '你的棋盘', `${state.draft.units.length} / 12 个棋子`, el('div', { class: 'draft-status' }, el('span', { class: 'status-dot' }), `草案 v${state.draft.version} · 自动保存`));
  $('h2', teamHeader).id = 'team-title'; teamPanel.append(teamHeader);
  const board = el('div', { class: 'panel-body' });
  if (!state.draft.units.length) board.append(el('div', { class: 'empty-board' }, el('div', { class: 'empty-symbol', text: '♙' }), el('h3', { text: '从你的主力棋子开始' }), el('p', { text: '添加输出、前排和辅助，为他们设置装备分配优先级。你也可以从英雄资料页带入。' }), btn('选择英雄 →', () => picker('champions', addChampion), 'secondary', !state.catalog.champions.length)));
  else {
    const units = el('div', { class: 'units-grid' }); state.draft.units.forEach(unit => units.append(unitCard(unit))); board.append(units);
    board.append(el('div', { class: 'actions', style: { marginTop: '12px', justifyContent: 'space-between' } }, btn('+ 添加棋子', () => picker('champions', addChampion), 'ghost small', state.draft.units.length >= 12), btn('清空棋盘', () => confirmClear(), 'ghost small')));
  }
  board.append(el('p', { class: 'panel-footnote', text: '◇ 数字越大优先级越高；锁定装备视为已穿戴，不会重复消耗仓库。' }));
  teamPanel.append(board); grid.append(teamPanel, inventoryPanel(), planPanel()); main.append(grid);
  main.append(el('div', { class: 'quick-link-row' }, el('span', {}, '不确定一件装备如何合成？ ', el('span', { class: 'muted-text', text: '核对配方后再做决定。' })), btn('打开合成图鉴 ↗', () => navigate('recipes'), 'ghost small')));
  main.append(el('p', { class: 'footer-note', text: '本工具用于手动模拟与学习。分配方案核对资源和槽位，不将单英雄装备统计推断为全队胜率，也不会自动读取或操作游戏。' }));
}
function unitCard(unit) {
  const champion = byId('champions', unit.championId) || { id: unit.championId, name: `未识别 · ${unit.championId}` };
  const card = el('article', { class: 'unit-card', style: { '--unit-color': COST_COLORS[champion.cost] || '#57717a' } });
  card.append(el('div', { class: 'unit-top' }, entityImage(champion), el('div', {}, el('h3', { text: entityName(champion) }), el('small', { text: `${champion.cost ? `${champion.cost} 费 · ` : ''}${Array.isArray(champion.traits) ? champion.traits.join(' / ') : '羁绊未知'}` })), el('button', { class: 'icon-button', type: 'button', 'aria-label': `移除${entityName(champion)}`, onclick: () => editDraft(d => { d.units = d.units.filter(u => u.instanceId !== unit.instanceId); delete d.preferences[unit.instanceId]; }) }, '×')));
  const roleSelect = el('select', { 'aria-label': `${entityName(champion)}角色`, onchange: event => editDraft(d => { d.units.find(u => u.instanceId === unit.instanceId).role = event.target.value; }) }, Object.entries(ROLE_LABELS).map(([id, name]) => el('option', { value: id, selected: unit.role === id, text: name })));
  card.append(el('div', { class: 'unit-controls' }, el('div', {}, el('label', { class: 'field-label', text: '分配角色' }), roleSelect), el('div', {}, el('label', { class: 'field-label', text: '优先级' }), counter(unit.priority, `${entityName(champion)}优先级`, qty => editDraft(d => { d.units.find(u => u.instanceId === unit.instanceId).priority = qty; }), 1))));
  const locked = el('div', { class: 'locked-items' });
  unit.lockedItems.forEach((itemId, index) => { const item = byId('items', itemId); locked.append(el('span', { class: 'locked-item' }, itemTinyImage(item), entityName(item || { id: itemId }), el('button', { type: 'button', 'aria-label': `解除${entityName(item || { id: itemId })}锁定`, onclick: () => editDraft(d => d.units.find(u => u.instanceId === unit.instanceId).lockedItems.splice(index, 1)) }, '×'))); });
  const slotUsage = unit.lockedItems.reduce((sum, id) => sum + (byId('items', id)?.slotCost || 1), 0);
  if (slotUsage < 3) locked.append(el('button', { type: 'button', class: 'locked-add', onclick: () => picker('items', item => editDraft(d => d.units.find(u => u.instanceId === unit.instanceId).lockedItems.push(item.id)), { filter: i => (i.slotCost || 1) + slotUsage <= 3 && (!i.unique || !unit.lockedItems.includes(i.id)), title: '选择已穿戴的锁定装备' }) }, '+ 锁定装备'));
  card.append(el('span', { class: 'field-label', text: `已穿戴 / 锁装 · 占用 ${slotUsage}/3 槽` }), locked);
  const preferences = state.draft.preferences?.[unit.instanceId] || [];
  const preferred = el('div', { class: 'locked-items' });
  preferences.forEach((id, index) => {
    const item = byId('items', id);
    preferred.append(el('span', { class: 'locked-item preference-item' }, el('span', { text: `${index + 1}. ${entityName(item || { id })}` }), el('button', { type: 'button', 'aria-label': `移除偏好${entityName(item || { id })}`, onclick: () => editDraft(d => { d.preferences[unit.instanceId].splice(index, 1); if (!d.preferences[unit.instanceId].length) delete d.preferences[unit.instanceId]; }) }, '×')));
  });
  if (preferences.length < 6) preferred.append(el('button', { type: 'button', class: 'locked-add', onclick: () => picker('items', item => editDraft(d => { if (!d.preferences[unit.instanceId]) d.preferences[unit.instanceId] = []; d.preferences[unit.instanceId].push(item.id); }), { filter: i => i.kind !== 'component' && !preferences.includes(i.id), title: '选择偏好装备（按添加顺序优先）' }) }, '+ 偏好装备'));
  card.append(el('span', { class: 'field-label', style: { marginTop: '11px' }, text: '偏好出装 · 需要实际资源支持' }), preferred);
  return card;
}
function addChampion(champion) {
  if (state.draft.units.length >= 12) return toast('当前工作台最多添加 12 个棋子。', true);
  editDraft(d => { const role = /tank|坦|front/i.test(champion.role || '') ? 'tank' : /support|辅助/i.test(champion.role || '') ? 'support' : 'carry'; d.units.push({ instanceId: crypto.randomUUID(), championId: champion.id, role, priority: 3, lockedItems: [] }); }, `已添加 ${entityName(champion)}`);
}
function updateInventory(section, itemId, qty) {
  editDraft(d => { if (qty) d[section][itemId] = qty; else delete d[section][itemId]; });
}
function inventoryPanel() {
  const panel = el('section', { class: 'panel', 'aria-labelledby': 'inventory-title' });
  const total = countValues(state.draft.components) + countValues(state.draft.completedItems);
  const header = panelHeader('02', '资源仓库', null, el('span', { class: 'inventory-total', text: `${total} 件可用资源` })); $('h2', header).id = 'inventory-title'; panel.append(header);
  const tabs = [['components', '散件库存'], ['completedItems', '已有成装'], ['reserve', '预留散件']];
  panel.append(el('div', { class: 'inventory-tabs', role: 'tablist', 'aria-label': '库存类型' }, tabs.map(([id, text]) => el('button', { class: state.inventoryTab === id ? 'active' : '', role: 'tab', 'aria-selected': state.inventoryTab === id, onclick: () => { state.inventoryTab = id; renderMain(); } }, text, el('small', { text: countValues(state.draft[id]) })))));
  const body = el('div', { class: 'panel-body', role: 'tabpanel' });
  if (state.inventoryTab === 'completedItems') {
    body.append(el('p', { class: 'inventory-note', text: '填写还在装备席、可以分配的成装。棋子已穿戴的装备请在棋盘上锁定。' }));
    const stocks = Object.entries(state.draft.completedItems);
    stocks.forEach(([id, qty]) => { const item = byId('items', id) || { id, name: `未识别 · ${id}` }; body.append(el('div', { class: 'inventory-existing' }, entityImage(item), el('div', {}, el('h3', { text: entityName(item) }), el('small', { text: '装备席 · 可分配' })), counter(qty, `${entityName(item)}库存`, n => updateInventory('completedItems', id, n)), el('button', { class: 'icon-button', 'aria-label': `移除${entityName(item)}`, onclick: () => updateInventory('completedItems', id, 0) }, '×'))); });
    body.append(el('button', { class: 'inventory-add', type: 'button', onclick: () => picker('items', item => updateInventory('completedItems', item.id, (state.draft.completedItems[item.id] || 0) + 1), { filter: i => i.kind !== 'component', title: '添加装备席成装 / 特殊装备' }) }, '+ 添加已有成装'));
  } else {
    const reserve = state.inventoryTab === 'reserve';
    body.append(el('p', { class: 'inventory-note', text: reserve ? '预留从散件库存中扣除，规划器不会使用。预留数量不能超过该散件的库存。' : '只填写未使用的散件。数量可用 + / − 调整，也可以直接输入。' }));
    const components = state.catalog.items.filter(i => i.kind === 'component');
    if (!components.length) body.append(empty('散件资料暂不可用', '资源包载入后这里会显示可核验的散件。', [], '◈'));
    else {
      const grid = el('div', { class: 'inventory-grid' });
      components.forEach(item => {
        const qty = state.draft[state.inventoryTab][item.id] || 0;
        grid.append(el('div', { class: `inventory-cell${qty ? ' has-stock' : ''}` }, entityImage(item), el('span', { class: 'inventory-name', text: entityName(item) }), counter(qty, `${entityName(item)}${reserve ? '预留' : '库存'}`, n => updateInventory(state.inventoryTab, item.id, n))));
      }); body.append(grid);
    }
    if (reserve) { const over = Object.entries(state.draft.reserve).filter(([id, qty]) => qty > (state.draft.components[id] || 0)); if (over.length) body.append(el('p', { class: 'panel-footnote', style: { color: 'var(--gold)' }, text: `预留超出库存：${over.map(([id]) => entityName(byId('items', id) || { id })).join('、')}` })); }
  }
  panel.append(body); return panel;
}
function ledger(title, values) {
  const entries = Array.isArray(values) ? values.map(x => [x.itemId || x.id, x.quantity ?? x.qty ?? 1]) : Object.entries(values || {});
  const content = entries.filter(([, qty]) => Number(qty) > 0).map(([id, qty]) => el('span', { text: `${entityName(byId('items', id) || { id })} ×${qty}` }));
  return el('div', {}, el('h4', { text: title }), el('p', { class: content.length ? '' : 'empty' }, content.length ? content : '无'));
}
function planPanel() {
  const panel = el('section', { class: 'panel plan-panel', 'aria-labelledby': 'plan-title' });
  const header = panelHeader('03', '全队分配方案', null, el('span', { class: 'tag neutral', text: '资源 · 槽位 · 唯一性' })); $('h2', header).id = 'plan-title'; panel.append(header);
  const body = el('div', { class: 'plan-body' });
  if (state.planError) body.append(el('div', { class: 'warning-box' }, el('strong', { text: '当前条件无法生成方案' }), el('p', { text: state.planError })));
  if (!state.plan) body.append(el('div', { class: 'plan-placeholder' }, el('div', { class: 'plan-visual', 'aria-hidden': 'true' }, el('span', { text: '♙' }), el('i', { text: '+' }), el('span', { text: '◈' }), el('i', { text: '→' }), el('span', { text: '✦' })), el('h3', { text: '每件装备都有自己的去处' }), el('p', { text: '填好棋盘和库存后，规划器将逐件分配。资源不足时会保留空槽，并说明约束。' })));
  else {
    const plan = state.plan;
    if (!currentPlan()) body.append(el('div', { class: 'stale-plan', text: `草案已更新至 v${state.draft.version}。下方方案基于 v${plan.draftVersion}，请重新规划后保存或使用。` }));
    body.append(el('div', { class: 'plan-status' }, el('span', { class: `status-dot${plan.feasible === false ? ' warning' : ''}` }), plan.feasible === false ? '当前约束无法满足' : `已生成可核对方案 · v${plan.draftVersion}`));
    if (Array.isArray(plan.warnings) && plan.warnings.length) body.append(el('div', { class: 'warning-box', style: { marginTop: '13px' } }, el('strong', { text: '需要留意' }), el('ul', {}, plan.warnings.map(w => el('li', { text: typeof w === 'string' ? w : str(w.message || w.reason || w) })))));
    (plan.assignments || []).forEach(assignment => {
      const champion = byId('champions', assignment.championId) || { id: assignment.championId };
      const items = el('div', { class: 'plan-items' });
      (assignment.items || []).forEach(planned => { const item = byId('items', planned.itemId) || { id: planned.itemId, name: planned.name }; const origin = ({ locked: '已锁定', completed: '已有成装', crafted: '由库存合成', craft: '由库存合成', inventory: '已有成装' })[planned.origin] || str(planned.origin, '规划分配'); items.append(el('span', { class: 'plan-item' }, itemTinyImage(item), el('span', {}, entityName(item), el('small', { text: origin })))); });
      if (!(assignment.items || []).length) items.append(el('span', { class: 'muted-text', text: '保留空槽' }));
      const usedSlots = (assignment.items || []).reduce((sum, planned) => sum + (byId('items', planned.itemId)?.slotCost || 1), 0);
      body.append(el('div', { class: 'plan-assignment' }, entityImage(champion), el('div', {}, el('h3', { text: entityName(champion) }), el('span', { class: 'slot-note', text: `${usedSlots}/3 槽` })), items));
    });
    body.append(el('div', { class: 'resource-ledger' }, ledger('已使用散件', plan.usedComponents), ledger('剩余散件（含预留）', plan.remainingComponents), ledger('其中预留散件', plan.reservedComponents), ledger('已使用成装', plan.usedCompletedItems), ledger('剩余成装', plan.remainingCompletedItems)));
    if (plan.explanation) body.append(el('p', { class: 'plan-explanation', text: typeof plan.explanation === 'string' ? plan.explanation : str(plan.explanation) }));
    body.append(el('div', { class: 'actions', style: { marginTop: '15px' } }, btn('核对资源账本', validatePlan, 'ghost small', !currentPlan() || plan.feasible === false)));
  }
  panel.append(body, el('div', { class: 'plan-toolbar' }, el('div', {}, el('p', { text: state.planning ? '正在核对配方与资源…' : '优先满足你设定的条件' }), el('small', { text: '不虚构胜率，不重复消耗同一件资源' })), btn(state.planning ? '规划中…' : '✦ 生成全队方案', generatePlan, 'primary', state.planning || !state.draft.units.length || catalogMissing(state.draft) || draftContextBlocked())));
  return panel;
}
async function generatePlan() {
  if (state.planning || !state.draft.units.length || draftContextBlocked()) return;
  const draft = structuredClone(state.draft); state.planning = true; state.planError = null; renderMain();
  try {
    const result = await api('/api/plan', { draft }); const plan = result.plan || result;
    if (!Array.isArray(plan.assignments)) throw new Error('规划结果缺少分配记录');
    if (Number(plan.draftVersion) !== draft.version) throw new Error('规划版本与提交的草案不一致，请重试');
    state.plan = plan;
    if (state.draft.version !== draft.version) toast('计算期间草案已修改；结果保留为过期方案，请重新规划。', true);
    else toast(plan.feasible === false ? '已找到约束冲突，请查看方案说明。' : '全队分配完成，资源账本已生成。');
  } catch (error) { if (draft.version === state.draft.version) state.planError = error.message; toast(error.message, true); } finally { state.planning = false; renderMain(); updateChatContext(); }
}
async function validatePlan() {
  if (!currentPlan()) return toast('草案已改变，请重新生成方案。', true);
  const version = state.draft.version;
  try {
    const result = await api('/api/plan/validate', { draft: structuredClone(state.draft), plan: structuredClone(state.plan) });
    if (version !== state.draft.version) return toast('校验期间草案已改变，请重新规划。', true);
    const valid = result.valid ?? result.feasible ?? result.ok ?? result.validation?.valid;
    if (valid === false) { const errors = result.errors || result.violations || result.validation?.errors || ['资源约束未通过']; openTextModal('资源校验未通过', errors.map(e => typeof e === 'string' ? e : str(e.message || e)).join('\n')); }
    else if (valid === true) toast('资源守恒、装备槽位与锁装约束核对通过。');
    else openTextModal('资源校验结果', str(result));
  } catch (error) { toast(error.message, true); }
}
function confirmClear() {
  openModal('清空棋盘', el('div', {}, el('p', { class: 'modal-description', text: '移除当前全部棋子和锁装，库存仍保留。当前方案将过期。' }), el('div', { class: 'actions', style: { marginTop: '20px' } }, btn('取消', closeModal, 'ghost'), btn('清空棋盘', () => { closeModal(); editDraft(d => { d.units = []; d.preferences = {}; }); }, 'danger'))));
}
function searchMatches(entity, search) {
  const rules=entityDocuments(state.library,entity.id),offering=state.library?.augmentRules?.find(rule=>rule.id===entity.id);
  const haystack = [entity.name, entity.id, entity.apiName, ...(entity.aliases || []), ...(Array.isArray(entity.traits) ? entity.traits : []), offering?.nameOriginal, ...rules.flatMap(doc=>[doc.title,...doc.aliases])].join(' ').toLowerCase(); return haystack.includes(search.toLowerCase().trim());
}
function augmentDescription(entity) {
  return state.library?.augmentRules?.find(rule=>rule.id===entity.id)?.descriptionZh || state.library?.catalogTranslations?.find(row=>row.id===entity.id)?.descriptionZh || readableDescription(entity.description,'来源未提供效果说明');
}
function augmentTier(entity) {return ({silver:'白银',gold:'黄金',prism:'棱彩'})[entity.tier] || state.library?.augmentRules?.find(rule=>rule.id===entity.id)?.tier || '位阶未记录';}
function catalogCard(entity, type, onClick = () => openEntity(type, entity.id)) {
  return el('button', { type: 'button', class: `entity-card ${type.slice(0, -1)}`, onclick: onClick, style: { '--unit-color': COST_COLORS[entity.cost] || '#456b61' } }, entityImage(entity), type === 'champions' && entity.cost ? el('span', { class: 'cost-badge', text: `${entity.cost} ◆` }) : null,
    el('h3', { text: entityName(entity) }), type === 'champions' ? el('p', { text: Array.isArray(entity.traits) ? entity.traits.join(' · ') : '羁绊未知' }) : el('p', { class: 'brief-desc', text: type==='augments'?augmentDescription(entity):readableDescription(entity.description, '该来源未提供效果文本') }), el('div', { class: 'card-type', text: type === 'items' ? entity.category === 'radiant' ? '光明装备' : entity.category === 'artifact' ? '奥恩神器' : ({ component: '基础散件', completed: '合成装备', special: '特殊装备' })[entity.kind] || '装备' : type === 'champions' ? str(entity.role, '角色未标记') : type === 'augments' ? augmentTier(entity) : '查看效果与档位' }), entityDocuments(state.library,entity.id).length?el('span',{class:'library-card-badge',text:type==='augments'?'含奖励 / 交互细则':'含机制细则'}):null);
}
function renderCatalog(main, type, options = {}) {
  const name = TYPE_LABELS[type];
  const artifact = Boolean(options.category);
  const sourceList = (state.catalog[type] || []).filter(entity => !options.category || entity.category === options.category);
  main.append(guideNav(), heading('THE FIELD GUIDE', artifact ? options.category==='radiant'?'光明装备':'奥恩神器' : `${name}资料库`, artifact ? '查看装备效果、独特规则与已收录的持有者统计。' : type==='augments'?'点击海克斯查看中文奖励、出现条件与互斥规则。基础效果与补充规则的来源版本分别保留。':'以实际下载的版本资源为准，点击条目查看效果、配方与来源。'));
  if (type === 'items') main.append(equipmentCategoryNav());
  if (!sourceList.length) return main.append(empty(artifact ? '当前资料包暂未收录奥恩神器' : `${name}资料暂不可用`, state.catalogError || '只展示真实已收录条目，请查看来源状态。', [btn('查看数据源', () => navigate('sources'), 'secondary')], '◈'));
  const search = el('input', { type: 'search', placeholder: `搜索${name}名称或 ID…`, 'aria-label': `搜索${name}`, value: state.filter.search });
  const filters = el('div', { class: 'view-search' }, search);
  if (type === 'champions') filters.append(el('select', { 'aria-label': '费用筛选', onchange: e => { state.filter.cost = e.target.value; updateResults(); } }, el('option', { value: '', text: '全部费用' }), [...new Set(state.catalog.champions.map(c => c.cost).filter(Boolean))].sort((a,b) => a-b).map(cost => el('option', { value: cost, selected: String(cost) === state.filter.cost, text: `${cost} 费` }))));
  if (type === 'items' && !artifact) filters.append(el('select', { 'aria-label': '装备类型筛选', onchange: e => { state.filter.kind = e.target.value; updateResults(); } }, [['', '全部类型'], ['component', '基础散件'], ['completed', '合成装备'], ['special', '特殊装备']].map(([value, name]) => el('option', { value, selected: value === state.filter.kind, text: name }))));
  const rewardFilter=type==='augments'?el('select',{'aria-label':'海克斯资料筛选',onchange:()=>updateResults()},el('option',{value:'',text:'全部海克斯'}),el('option',{value:'rewards',text:'有奖励 / 交互细则'}),el('option',{value:'conditions',text:'有出现条件'})):null;
  if(rewardFilter)filters.append(rewardFilter);
  const count = el('span', { class: 'result-count' }); filters.append(count); main.append(filters);
  const results = el('div', { class: 'catalog-grid' }); main.append(results);
  function updateResults() {
    const list = sourceList.filter(e => searchMatches(e, state.filter.search) && (!state.filter.cost || String(e.cost) === state.filter.cost) && (!state.filter.kind || artifact || e.kind === state.filter.kind) && (!rewardFilter?.value || (rewardFilter.value==='rewards'?entityDocuments(state.library,e.id).length:state.library?.augmentRules?.some(rule=>rule.id===e.id))));
    count.textContent = `${list.length} ${type === 'champions' ? '个英雄 / 形态' : '个条目'}`; results.replaceChildren(...list.map(entity => catalogCard(entity, type)));
    if (!list.length) results.append(el('p', { class: 'muted-text', text: '没有匹配条目，试试其他名称或 ID。' }));
  }
  search.addEventListener('input', e => { state.filter.search = e.target.value; updateResults(); }); updateResults();
  main.append(el('p', { class: 'footer-note', text: '条目数代表当前资源包的实际覆盖，不代表全部历史赛季。未提供的文本、档位与数据会明确标记。' }));
}
function renderRecipes(main) {
  main.append(guideNav(), heading('EVERY PIECE MATTERS', '合成图鉴', '查看已验证的常规装备与转职合成配方。'));
  const recipes = state.catalog.items.filter(i => i.recipeVerified === true && Array.isArray(i.components) && i.components.length === 2 && i.components.every(id => byId('items', id)?.kind === 'component'));
  if (!recipes.length) return main.append(empty('暂无已验证配方', '该资源包还没有提供已验证的双散件配方。', [btn('查看来源', () => navigate('sources'), 'secondary')], '⚒'));
  const search = el('input', { type: 'search', placeholder: '搜索成装或组成散件…', 'aria-label': '搜索配方' });
  const component = el('select', { 'aria-label': '按散件筛选' }, el('option', { value: '', text: '全部散件' }), state.catalog.items.filter(i => i.kind === 'component').map(i => el('option', { value: i.id, text: entityName(i) })));
  const count = el('span', { class: 'result-count' }); main.append(el('div', { class: 'view-search' }, search, component, count)); const grid = el('div', { class: 'recipe-grid' }); main.append(grid);
  const update = () => {
    const items = recipes.filter(i => (!component.value || i.components.includes(component.value)) && (searchMatches(i, search.value) || i.components.some(id => searchMatches(byId('items', id) || { id }, search.value))));
    count.textContent = `${items.length} 条配方`;
    grid.replaceChildren(...items.map(item => {
      const parts = item.components.map((id, index) => {
        const part = byId('items', id) || { id };
        return [index ? el('b', { text: '+' }) : null, itemTinyImage(part), el('span', { text: entityName(part) })];
      });
      return el('button', { class: 'recipe-card', onclick: () => openEntity('items', item.id) },
        el('div', { class: 'recipe-top' }, entityImage(item), el('h3', { text: entityName(item) })),
        el('div', { class: 'recipe-parts' }, parts));
    }));
  }; search.addEventListener('input', update); component.addEventListener('change', update); update();
}
function openModal(title, body, subtitle = '') {
  const dialog = $('#modal');
  $('#modal-content').replaceChildren(el('div', { class: 'modal-heading' }, el('div', {}, el('h2', { text: title }), subtitle ? el('p', { class: 'modal-subtitle', text: subtitle }) : null), el('button', { type: 'button', class: 'icon-button', 'aria-label': '关闭弹窗', onclick: closeModal }, '×')), el('div', { class: 'modal-body' }, body));
  if (!dialog.open) dialog.showModal();
  const focus = $('input,button', body); if (focus) setTimeout(() => focus.focus({ preventScroll: true }), 0);
}
function closeModal() { $('#modal').close(); }
function openTextModal(title, content) { openModal(title, el('p', { class: 'modal-description', text: content })); }
function picker(type, onSelect, options = {}) {
  const search = el('input', { type: 'search', 'aria-label': '搜索可添加条目', placeholder: `搜索${TYPE_LABELS[type]}名称或 ID…` });
  const grid = el('div', { class: 'modal-catalog' });
  const body = el('div', {}, el('div', { class: 'modal-filters' }, search), grid);
  const update = () => { const list = state.catalog[type].filter(entity => (!options.filter || options.filter(entity)) && searchMatches(entity, search.value)); grid.replaceChildren(...list.map(entity => catalogCard(entity, type, () => { closeModal(); onSelect(entity); }))); if (!list.length) grid.append(el('p', { class: 'muted-text', text: '当前资料库中没有匹配条目。' })); };
  search.addEventListener('input', update); update(); openModal(options.title || `选择${TYPE_LABELS[type]}`, body, '来自当前资源包；不会混合历史赛季实体。');
}
function openEntity(type, id) {
  const entity = byId(type, id); if (!entity) return toast('当前资料包没有这个条目。', true);
  state.entityId = id; state.statEntity = null; state.mechanicEntity = null; state.libraryDocumentId = null; updateChatContext();renderSuggestions();
  const body = el('div');
  body.append(el('div', { class: 'unit-top' }, entityImage(entity), el('div', {}, el('h3', { text: entityName(entity) }), el('small', { text: type==='augments'?state.library?.augmentRules?.find(rule=>rule.id===id)?.nameOriginal || '强化符文':entity.id }))));
  if (type === 'champions') {
    if (Array.isArray(entity.traits)) body.append(el('div', { class: 'detail-traits' }, entity.traits.map(t => el('span', { text: t }))));
    body.append(el('div', { class: 'details-facts' }, el('div', {}, el('span', { text: '费用' }), el('strong', { text: entity.cost ? `${entity.cost} 费` : '未知' })), el('div', {}, el('span', { text: '资料角色' }), el('strong', { text: str(entity.role, '未提供') }))));
    body.append(el('div', { class: 'modal-section' }, el('h3', { text: entity.ability?.name || '技能' }), el('p', { class: 'modal-description', text: readableDescription(entity.ability?.description, '该资源包未提供可渲染的技能文本。') })));
    if (entity.ability?.descriptionIncomplete) body.append(el('p', { class: 'panel-footnote', style: { color: 'var(--gold)' }, text: '技能文本含来源无法解析的数值，已明确保留为「数值未知」。' }));
  } else {
    const translated=type==='augments'&&augmentDescription(entity)!==entity.description;
    body.append(el('p', { class: 'modal-description', style: { marginTop: '13px' }, text: type==='augments'?augmentDescription(entity):readableDescription(entity.description, '该资源包未提供效果文本。') }));
    if(translated)body.append(el('details',{class:'library-legacy'},el('summary',{text:'查看旧目录原始文本与来源'}),el('p',{class:'modal-description',text:readableDescription(entity.description)}),el('p',{class:'library-table-note',text:`旧目录资源 ${state.catalog.context.assetVersion}；中文补充说明的来源版本单独列出，不合并推断。`})),el('p',{class:'library-table-note',text:state.library?.augmentRules?.find(rule=>rule.id===id)?.descriptionZh?'以上中文说明：Little Buddy Bot 18.4。':'以上中文说明：对当前目录英文效果的翻译；出现条件尚未核验。'}));
    if (!translated && entity.descriptionLanguage && entity.descriptionLanguage !== 'zh_cn' && entity.descriptionLanguage !== 'zh_CN') body.append(el('p', { class: 'panel-footnote', text: hasSourceTranslation(entity.description)?'简中说明为项目翻译，英文模式显示来源原文。':`文本语言 ${entity.descriptionLanguage} · 当前来源未提供完整中文说明。` }));
    if (entity.descriptionIncomplete) body.append(el('p', { class: 'panel-footnote', style: { color: 'var(--gold)' }, text: '该效果文本有未解析数值，不能将未知字段用于定量结论。' }));
    if (type === 'items') body.append(el('div', { class: 'details-facts' }, el('div', {}, el('span', { text: '占用槽位' }), el('strong', { text: `${entity.slotCost || 1} 槽` })), el('div', {}, el('span', { text: '唯一装备' }), el('strong', { text: entity.unique ? '同棋子不能重复' : '否' })), el('div', {}, el('span', { text: '自动合成' }), el('strong', { text: entity.kind === 'completed' && entity.recipeVerified !== false && entity.components?.length === 2 ? '配方已核验' : '不参与自动合成' }))));
    if (type === 'items' && Array.isArray(entity.components) && entity.components.length) body.append(el('div', { class: 'modal-section' }, el('h3', { text: '组成配方' }), el('div', { class: 'recipe-parts', style: { margin: '0', border: '0', padding: '0' } }, entity.components.map((itemId, index) => { const part = byId('items', itemId) || { id: itemId }; return [index ? el('b', { text: '+' }) : null, itemTinyImage(part), el('span', { text: entityName(part) })]; }))));
    if (Array.isArray(entity.effects) && entity.effects.length) body.append(el('div', { class: 'modal-section' }, el('h3', { text: '效果档位' }), entity.effects.map(effect => el('p', { class: 'modal-description', text: typeof effect === 'string' ? readableDescription(effect) : effect.description || effect.desc ? readableDescription(effect.description || effect.desc) : effect.minUnits != null ? `${effect.minUnits} 个棋子触发此档位，效果以资料说明为准。` : '来源未提供可读的档位说明。' }))));
  }
  const actions = [btn('✧ 询问这条资料', () => { closeModal(); showChat(true); $('#chat-input').value = `请根据当前版本解释${entityName(entity)}，指出来源与未知字段。`; $('#chat-input').focus(); }, 'ghost')];
  body.append(el('div', { class: 'modal-section' }, el('div', { class: 'actions' }, actions)));
  const provenance = typeof entity.source === 'object' ? Object.entries(entity.source || {}).map(([key, value]) => `${({ identity: '实体', description: '文本', recipe: '配方' })[key] || key} ${value}`).join(' / ') : entity.source;
  body.append(el('p', { class: 'modal-source', text: `${type==='augments'?'基础图鉴来源':'资料来源'}：${str(provenance || state.catalog.context.source || state.catalog.context.source_id, '静态资源包')} · 资源版本：${str(state.catalog.context.assetVersion || state.catalog.context.asset_version)}。${type==='augments'?'中文补充与奖励表的来源版本见对应说明。':'技能与效果仅按来源提供的文本显示。'}` }));
  if (type === 'champions' || type === 'items' && entity.kind !== 'component') {
    const statsBody = el('div', { class: 'detail-stat-content' });
    const section = el('section', { class: 'modal-section' }, el('h3', { text: type === 'champions' ? '单英雄出装统计' : '装备持有者统计' }), statsBody);
    body.append(section);
    statsBody.append(el('p', { class: 'muted-text', text: '只读取当前版本的本地统计缓存。未收录时明确留白；统计补丁与样本群体可能未知。' }), btn('查看缓存统计', () => loadEntityStats(type, id, statsBody), 'secondary small'));
  }
  openModal(type === 'items' && entity.category === 'artifact' ? '奥恩神器详情' : `${TYPE_LABELS[type]}详情`, body);
  if(['augments','traits'].includes(type))appendLibraryKnowledge(body,type,id);
}
function statisticValue(value, percent = false) {
  if (value == null || typeof value === 'boolean' || typeof value === 'string' && !value.trim() || !Number.isFinite(Number(value))) return '未知';
  return percent ? `${(Number(value) <= 1 ? Number(value) * 100 : Number(value)).toFixed(1)}%` : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
async function loadEntityStats(type, id, container) {
  container.replaceChildren(el('p', { class: 'muted-text' }, el('span', { class: 'spinner small' }), ' 正在读取本地版本缓存…'));
  try {
    const result = await api(type === 'champions' ? `/api/champions/${encodeURIComponent(id)}/build?rank=${pageRank()}` : `/api/items/${encodeURIComponent(id)}/holders?rank=${pageRank()}`, undefined, 45000);
    if (!container.isConnected) return;
    container.replaceChildren();
    if (result.status !== 'live' || !Array.isArray(result.data) || !result.data.length) {
      container.append(el('div', { class: 'warning-box' }, el('strong', { text: result.code === 'not_supported' ? '来源暂不支持此统计' : result.status === 'not_cached' ? '当前版本缓存尚未收录' : result.status === 'live' ? '当前缓存未匹配到统计记录' : '本地统计缓存暂不可用' }), el('p', { text: str(result.reason, '该实体在当前版本中没有已收录的统计记录。') })), el('p', { class: 'panel-footnote', text: '本次只读本地缓存，不会触发外部 API 查询。' }), btn('重新查看缓存', () => loadEntityStats(type, id, container), 'ghost small')); return;
    }
    const evidence = Array.isArray(result.evidence) ? result.evidence[0] : result.evidence || {};
    const facts = el('div', { class: 'stat-context' },
      el('span', { class: 'context-pill valid', text: evidence.delivery === 'version_cache' || result.delivery === 'version_cache' ? '本地版本缓存' : '已收录的本地快照' }),
      el('span', { class: 'context-pill unknown', text: `统计补丁 ${patchContext(evidence).label}` }),
      el('span', { class: 'context-pill', text: evidence.rank || evidence.population?.rank || '段位未提供' }),
      el('span', { class: 'context-pill', text: `${result.data.length} 条实际匹配记录` }));
    container.append(facts, el('p', { class: 'panel-footnote', text: `源更新时间：${evidence.sourceTime ? formatTime(evidence.sourceTime) : '未知'} · 缓存采集：${evidence.fetchedAt ? formatTime(evidence.fetchedAt) : '未知'}` }));
    const table = el('table', { class: 'status-table entity-stats' });
    table.append(el('thead', {}, el('tr', {}, ['来源组合', '均次', '前四率', '样本'].map(title => el('th', { scope: 'col', text: title })))));
    const tableBody = el('tbody');
    result.data.slice(0, 12).forEach(row => {
      const label = type === 'champions' ? el('div', { class: 'stats-build' }, (row.items || []).map(item => el('span', { title: item.name, class: 'stats-build-item' }, itemTinyImage(item), el('span', { text: entityName(item) })))) : el('button', { type: 'button', class: 'stats-holder', onclick: () => openEntity('champions', row.championId || row.id) }, entityImage(row), el('span', { text: row.name || row.championId }));
      const stats = row.stats || {};
      tableBody.append(el('tr', {}, el('td', {}, label), el('td', { text: statisticValue(stats.avgPlacement) }), el('td', { text: statisticValue(stats.top4Rate, true) }), el('td', { text: statisticValue(stats.sampleSize) })));
    }); table.append(tableBody); container.append(table);
    container.append(el('p', { class: 'panel-footnote', text: type === 'champions' ? '样本分母：该三件套的英雄出现次数。仅展示返回顺序前 12 条；不能推断为全队最优。' : '样本分母：持有此装备的英雄出现次数。仅展示返回顺序前 12 条；不会把相关性解释为装备的因果提升。' }), evidenceLinks(result.evidence));
  } catch (error) { if (container.isConnected) container.replaceChildren(el('div', { class: 'warning-box' }, el('strong', { text: '本地缓存读取未完成' }), el('p', { text: error.message })), btn('重新查看缓存', () => loadEntityStats(type, id, container), 'ghost small')); }
}
function formatTime(value) { if (!value) return '时间未知'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function resetDraftForContext() {
  openModal('开始当前版本草案', el('div', {}, el('p', { class: 'modal-description', text: '替换当前棋盘、库存与预留条件。旧版本草案会先归档在此浏览器。' }), el('div', { class: 'actions', style: { marginTop: '18px' } }, btn('取消', closeModal, 'ghost'), btn('归档旧草案并新建', () => {
    const record = { schemaVersion: 1, id: crypto.randomUUID(), name: '旧版本自动恢复草案', createdAt: new Date().toISOString(), contextKey: state.draftContextKey, context: state.draftContext || {}, draft: structuredClone(state.draft), plan: null };
    const next = [record, ...state.saved].slice(0, 60);
    if (!writeLocal(STORAGE.saved, next)) return;
    state.saved = next; const version = state.draft.version + 1; state.draft = freshDraft(); state.draft.version = version; state.draftContextKey = contextKey(); state.draftContext = structuredClone(state.catalog.context); state.plan = null; state.planError = null;
    persistDraft(); closeModal(); navigate('workbench'); renderChat(); toast('旧草案已归档，当前版本草案已建立。');
  }, 'primary'))));
}
function deckUnits(deck) {
  const units = deck.units || deck.champions || [];
  return Array.isArray(units) ? units.map(u => typeof u === 'string' ? u : u.championId || u.characterId || u.apiName || u.id).filter(Boolean) : [];
}
function renderDecks(main, options = {}) {
  if (!options.embedded) main.append(heading('EXPLORE WITH EVIDENCE', '阵容发现', '查阅来源阵容、棋子名单与统计表现。'));
  const result = state.decks;
  if (!result || result.status !== 'live' || !Array.isArray(result.data) || !result.data.length) {
    const reason = result?.reason || '尚未取得可核验的阵容统计响应。';
    main.append(el('div', { class: 'warning-box' }, el('strong', { text: result?.status === 'not_cached' ? '当前版本阵容缓存尚未收录' : '本地阵容缓存暂不可用' }), el('p', { text: typeof reason === 'string' ? reason : str(reason.message || reason) })));
    main.append(empty('阵容资料尚未收录', '可以继续查阅图鉴与合成配方。页面读取本地版本缓存，未收录的统计会明确留白。', [btn('查阅资料库 →', () => navigate('library'), 'secondary'), btn('查看数据源信息', () => navigate('sources'), 'ghost')], '▦')); return;
  }
  const delivery = result.delivery || (Array.isArray(result.evidence) ? result.evidence[0]?.delivery : result.evidence?.delivery);
  if (!options.embedded) main.append(el('div', { class: 'intro-strip' }, el('span', { class: 'intro-symbol', text: '◉' }), el('div', {}, el('strong', { text: delivery === 'version_cache' ? '当前版本的阵容缓存已载入' : '已收录的阵容快照已载入' }), el('p', { text: '统计补丁、段位、地区与样本时间缺失时保持未知，不与资源版本互相替代。' })), el('span', { class: 'tag', text: `${delivery === 'version_cache' ? '本地版本缓存 · ' : ''}${result.data.length} 个条目` })));
  else main.append(cacheContext(result));
  const cards = el('div', { class: 'stats-deck-results' });
  main.append(statsControls('decks', () => updateDecks(), '搜索阵容或其中的英雄…'), cards);
  function updateDecks() {
    const decks = filterStatRows(result.data, 'decks', deck => `${deck.name || deck.title || ''} ${deckUnits(deck).map(id => `${entityName(byId('champions', id) || { id })} ${id}`).join(' ')}`);
    cards.replaceChildren(el('p', { class: 'stats-result-heading', text: `${decks.length} / ${result.data.length} 个阵容 · 样本分母：匹配该阵容的场次` }));
    if (!decks.length) return cards.append(empty('没有匹配的阵容', '调整英雄名称、阵容名称或最低样本门槛。', [], '⌕'));
    decks.forEach((deck, index) => {
    const ids = deckUnits(deck); const mapped = ids.every(id => byId('champions', id));
    const stats = deck.stats || deck.stat?.deck || deck.stat || {};
    const card = el('article', { class: 'deck-card' }, el('div', { class: 'deck-title' }, el('h3', { text: deck.name || deck.title || `来源阵容 ${index + 1}` })), el('div', { class: 'deck-units' }, ids.map(id => { const champ = byId('champions', id) || { id }; return el('div', { class: 'deck-unit' }, entityImage(champ), entityName(champ)); })));
    const statGrid = el('div', { class: 'deck-stats' });
    if (Array.isArray(deck.traits) && deck.traits.length) card.append(el('div', { class: 'deck-traits' }, deck.traits.map(trait => el('span', { text: `${str(trait.name || trait.id)} ${trait.count ?? ''}` }))));
    [['平均名次', stats.avgPlacement, false], ['前四率', stats.top4Rate, true], ['第一率', stats.winRate, true], ['阵容样本', stats.sampleSize ?? stats.compsCount ?? stats.totalCount, false]].forEach(([label, value, pct]) => {
      let shown = '未知'; if (value != null && Number.isFinite(Number(value))) shown = pct ? `${(Number(value) <= 1 ? Number(value) * 100 : Number(value)).toFixed(1)}%` : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
      statGrid.append(el('div', {}, el('span', { text: label }), el('strong', { text: shown })));
    }); card.append(statGrid);
    if (!mapped) card.append(el('p', { class: 'panel-footnote', text: '部分来源棋子未映射到当前版本资料。' }));
    const evidence = deck.evidence || result.evidence || [];
    const sourceInfo = Array.isArray(evidence) ? evidence[0] || {} : evidence;
    card.append(el('p', { class: 'deck-source-context', text: `统计补丁：${str(sourceInfo.gamePatch)} · 地区 / 段位：未提供\n源更新时间：${sourceInfo.sourceTime ? formatTime(sourceInfo.sourceTime) : '未知'} · 缓存采集：${sourceInfo.fetchedAt ? formatTime(sourceInfo.fetchedAt) : '未知'}\n样本分母：阵容匹配场次。${sourceInfo.delivery === 'version_cache' || delivery === 'version_cache' ? '使用本地版本缓存。' : '使用已收录的来源快照。'}` }));
    if (Array.isArray(deck.stages) && deck.stages.length) {
      const details = el('details', { class: 'deck-stage-examples' }, el('summary', { text: '查看来源阶段示例' }), el('p', { class: 'panel-footnote', text: '以下是来源给出的棋盘示例，未观测到的搜牌、经济或升级过程保持未知。' }));
      deck.stages.forEach(stage => details.append(el('div', { class: 'deck-stage' }, el('h4', { text: `${({ early: '前期', middle: '中期' })[stage.stage] || str(stage.stage)} · 来源标示等级 ${str(stage.level)}` }), el('p', { text: (stage.units || []).map(u => u.name || u.id).join(' · ') || '未提供棋子' }), typeof stage.play === 'string' ? el('p', { text: stage.play }) : null)));
      card.append(details);
    }
      card.append(evidenceLinks(evidence, 'deck-evidence')); cards.append(card);
    });
  } updateDecks();
}
function importDeck(deck) {
  const ids = deckUnits(deck); if (!ids.length || ids.some(id => !byId('champions', id))) return toast('阵容棋子与当前资料无法完整映射。', true);
  if (draftContextBlocked()) return toast('请先在工作台新建当前版本草案。', true);
  const rows = ids.map((id, index) => {
    const source = typeof deck.units?.[index] === 'object' ? deck.units[index] : {};
    const champion = byId('champions', id);
    const role = Object.hasOwn(ROLE_LABELS, champion.role) ? champion.role : 'support';
    const sourcePriority = Number.isFinite(Number(source.priority)) && source.priority != null ? number(source.priority) : null;
    const priority = source.isCore ? 5 : 1;
    const preference = [...new Set((source.items || []).filter(itemId => byId('items', itemId)?.kind !== 'component' && byId('items', itemId)))];
    return { unit: { instanceId: crypto.randomUUID(), championId: id, role, priority, lockedItems: [] }, preference, sourcePriority, core: Boolean(source.isCore) };
  });
  const apply = () => { closeModal(); editDraft(d => { d.units = rows.map(r => r.unit); d.preferences = Object.fromEntries(rows.filter(r => r.preference.length).map(r => [r.unit.instanceId, r.preference])); }); navigate('workbench'); toast('棋子与来源偏好已带入，请核对角色、优先级并输入实际库存。'); };
  const preview = rows.map(r => `${entityName(byId('champions', r.unit.championId))} · ${r.core ? '来源核心' : '来源非核心'} · 来源优先级 ${str(r.sourcePriority)} → 工作台 ${r.unit.priority} · ${ROLE_LABELS[r.unit.role]}\n偏好：${r.preference.map(id => entityName(byId('items', id))).join('、') || '无'}`).join('\n\n');
  openModal('审阅阵容带入', el('div', {}, el('p', { class: 'modal-description', text: '替换当前棋盘，保留实际库存和预留条件。来源装备只作为偏好，不凭空增加库存或锁装。资料职责未知时默认为辅助，需你手动选择。核心默认 5，其他 1；来源排序方向未核验，需手动核对。' }), el('pre', { class: 'patch-preview', text: preview }), el('div', { class: 'actions', style: { marginTop: '18px' } }, btn('取消', closeModal, 'ghost'), btn('带入棋子与偏好', apply, 'primary'))));
}
function evidenceLinks(evidence, className = 'citation-list') {
  const list = el('div', { class: className }); const entries = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  entries.slice(0, 12).forEach((entry, index) => { const url = safeUrl(entry.url || entry.sourceUrl || entry.endpoint); const title = str(entry.title || entry.source || entry.id, `来源 ${index + 1}`); const description = entry.scope === 'general' ? `通用术语 · ${entry.sourceName || '本项目术语整理'} · 不代表当前补丁数值规则` : [entry.sourceTime ? `源时间 ${formatTime(entry.sourceTime)}` : '源更新时间未知', entry.fetchedAt ? `采集 ${formatTime(entry.fetchedAt)}` : '', `统计补丁 ${patchContext(entry).label}`].filter(Boolean).join(' · '); list.append(url ? el('a', { class: 'citation', href: url, target: '_blank', rel: 'noopener noreferrer', title: description, text: `↗ ${entry.id ? `[${entry.id}] ` : ''}${title}` }) : el('span', { class: 'citation', title: description, text: `${entry.id ? `[${entry.id}] ` : ''}${title}` })); }); return list;
}
function sourceList() {
  if (Array.isArray(state.sources)) return state.sources;
  if (Array.isArray(state.sources?.sources)) return state.sources.sources;
  if (state.sources && typeof state.sources === 'object') return Object.entries(state.sources).filter(([id,value]) => id !== 'context' && value && typeof value === 'object').map(([id, value]) => ({ id, name: ({ communityDragon: 'CommunityDragon 静态包', opgg: 'OP.GG MCP', tacticsTools: 'Tactics.tools 羁绊统计', tacticsOverall: 'Tactics.tools 弈子与装备统计' })[id] || id, ...value }));
  return [];
}
function showSourceDetails() {
  const body = el('div', { id: 'source-details-content' });
  renderSources(body); openModal('数据源信息', body);
}
function renderSources(main) {
  main.append(heading('KNOW WHAT YOU ARE USING', '数据源状态', '查看当前统计来源、采样范围与入库情况。MetaTFT 统计在有效期内读取 MySQL，缺项或过期时按请求更新。', [btn('↻ 重读本地状态', refreshSources, 'secondary')]));
  const list = sourceList();
  if (!list.length) main.append(empty('状态信息暂不可用', '本地服务未返回数据源诊断。可以刷新重试。', [btn('重新读取', refreshSources, 'secondary')], '◉'));
  const grid = el('div', { class: 'source-status-grid' });
  for (const source of list) {
    const status = source.status || (source.available ? 'available' : 'unknown');
    const healthy = ['live', 'available', 'ready', 'ok', 'verified', 'loaded', 'healthy'].includes(status);
    const label = healthy ? source.delivery === 'version_cache' ? '缓存可用' : '可用' : ({ archived: '历史归档', not_cached: '未收录', unavailable: '不可用', degraded: '部分可用', error: '连接失败', pending: '待验证', unknown: '未知', unconfigured: '未配置', disconnected: '未连接' })[status] || str(status);
    const reason = source.reason || source.failure?.message || source.message || source.description || source.note || (healthy ? '已取得当前资源或经验证的来源响应。' : '来源未返回详细说明。');
    const card = el('article', { class: 'source-card' }, el('div', { class: 'source-card-top' }, el('h3', { text: str(source.name || source.title || source.id, '来源') }), el('span', { class: `tag${healthy ? '' : ' gold'}`, text: label })), el('p', { text: typeof reason === 'string' ? reason : str(reason.message || reason) }));
    const facts = el('dl', { class: 'source-facts' });
    const coverage = source.id === 'tacticsTools' && source.coverage ? `${source.coverage.cachedTraits} / ${source.coverage.totalTraits} 个羁绊 · ${source.coverage.acceptedRows} 条档位记录` : source.coverage && typeof source.coverage === 'object' ? ['champions', 'items', 'traits', 'augments', 'verifiedRecipes', 'decks', 'championBuilds', 'itemHolders', 'emblemHolders'].filter(key => source.coverage[key] != null).map(key => {
      const name = ({champions:'英雄/形态',items:'装备',traits:'羁绊',augments:'强化符文',verifiedRecipes:'已核验配方',decks:'阵容',championBuilds:'出装覆盖',itemHolders:'装备携带者覆盖',emblemHolders:'转职覆盖'})[key];
      const value = source.coverage[key]; return `${name} ${typeof value === 'object' ? `${value.cached ?? '未知'} / ${value.total ?? '未知'}` : str(value)}`;
    }).join(' · ') : source.coverage || source.scope;
    [['交付方式', source.delivery === 'version_cache' ? '本地版本缓存' : source.id === 'communityDragon' ? '本地静态资源包' : source.delivery], ['资源版本', source.assetVersion || source.asset_version || source.version], ['统计补丁', source.requestedPatch ? patchContext(source).label : source.statPatch || source.stat_patch || source.gamePatch], ['源更新时间', source.sourceTime || source.source_time ? formatTime(source.sourceTime || source.source_time) : null], ['缓存采集', source.fetchedAt || source.fetched_at || source.checkedAt || source.lastChecked ? formatTime(source.fetchedAt || source.fetched_at || source.checkedAt || source.lastChecked) : null], ['覆盖范围', coverage]].forEach(([name, value]) => facts.append(el('dt', { text: name }), el('dd', { text: str(value) })));
    card.append(facts); if (source.url || source.endpoint) { const url = safeUrl(source.url || source.endpoint); if (url) card.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'citation', style: { marginTop: '12px' }, text: '查看来源 ↗' })); }
    if (Array.isArray(source.stages) && source.stages.length) card.append(el('div', { class: 'source-stage-list' }, source.stages.map(stage => el('p', { text: `${stage.name} · ${stage.status === 'ok' ? '实际响应已取得' : stage.status === 'schema_verified' ? '仅输入 schema 已验证' : str(stage.status)}` }))));
    if (Array.isArray(source.coverage?.limitations) && source.coverage.limitations.length) card.append(el('ul', { class: 'source-limitations' }, source.coverage.limitations.map(text => el('li', { text }))));
    grid.append(card);
  } main.append(grid);
  const health = state.health?.ai || {};
  main.append(el('section', { class: 'panel section-spacer' }, panelHeader('AI', 'TFT助手', null, el('span', { class: `tag${health.ready ? '' : ' gold'}`, text: health.ready ? '连接已验证' : health.configured ? '已配置 / 待验证' : '等待配置' })), el('div', { class: 'panel-body' }, el('p', { class: 'muted-text', text: `模型：${str(health.model)}。${health.ready ? 'TFT助手可以查阅当前页面资料，引用已取得的来源。' : '设置与联通状态以本地服务的验证结果为准。'}` }))));
  main.append(el('section', { class: 'note-card section-spacer' }, el('h3', { text: '如何理解这些状态' }), el('p', { style: { marginTop: '10px' }, text: '静态资料可用，表示当前版本资源已载入；它不证明统计数据处于同一补丁。MetaTFT 的统计原文与查询行存入 MySQL，当前有效期为 10 分钟；缺项或过期时向来源查询后入库。旧来源归档用于追溯，不作为失败时的替代统计。阵容缓存不可用时，图鉴仍可查阅。源更新时间未知时保留未知，缓存采集时间与源更新时间分别显示。' })));
}
async function refreshSources() {
  const results = await Promise.allSettled([api('/api/sources'), api('/api/health'), api('/api/decks')]);
  if (results[0].status === 'fulfilled') state.sources = results[0].value;
  if (results[1].status === 'fulfilled') state.health = results[1].value;
  if (results[2].status === 'fulfilled') state.decks = results[2].value;
  results.forEach(r => { if (r.status === 'rejected') toast(r.reason.message, true); });
  renderAIStatus(); renderMain(); renderContext();
  const details = $('#source-details-content');
  if ($('#modal').open && details) { details.replaceChildren(); renderSources(details); }
}
function updateChatContext() {
  const name = VIEWS.find(([id]) => id === state.view)?.[1] || '大数据';
  const entity = Object.keys(TYPE_LABELS).map(type => byId(type, state.entityId)).find(Boolean);
  const statChampion = state.statEntity?.kind === 'emblem' ? byId('champions', state.statEntity.championId) : null;
  const mechanic = state.mechanicEntity ? state.mechanics?.entries?.find(entry => entry.id === state.mechanicEntity.id) : null;
  const knowledge=state.library?.documents?.find(doc=>doc.id===state.libraryDocumentId),term=state.view==='glossary'?state.glossary?.entries?.find(entry=>entry.id===state.glossaryTermId):null;
  $('#chat-context').replaceChildren(el('span', { text: term?`云顶术语 · ${term.term}`:knowledge?knowledge.title:mechanic ? entityName(mechanic) : statChampion && entity ? `${entityName(statChampion)} · ${entityName(entity)}` : entity ? entityName(entity) : state.view === 'stats' ? `大数据 · ${STAT_TABS.find(([id]) => id === state.statsTab)?.[1] || '阵容'}` : name }));
  $('#chat-context-detail').textContent = '查询统计、图鉴与赛季机制';
}
function renderAIStatus() {
  const ai = state.health?.ai || {};
  const conditional = state.view === 'stats' && state.explorer?.mode === 'builds' || state.messages.at(-1)?.answerMode === 'conditional_statistics';
  $('#ai-status').textContent = conditional ? '条件出装 · 依据统计' : ai.ready ? '已连接 · 证据优先' : ai.configured ? '已配置 · 等待连接验证' : 'API 尚未配置';
  if(ai.model&&!conditional)$('#ai-status').textContent += ` · ${ai.model}`;
  $('#ai-dot').className = `status-dot${ai.ready || conditional ? '' : ' warning'}`;
  $('#chat-input').disabled = false;
  $('#chat-send').disabled = state.chatting;
  $('#chat-footer-status').textContent = state.chatting ? '正在理解问题、规划查询并核对来源…' : '依据当前资料回答';
}
function renderSuggestions() {
  const term=state.glossary?.entries?.find(entry=>entry.id===state.glossaryTermId);
  const suggestions = state.view==='glossary'?[`${term?.term || '慢D'}是什么意思？`,`${term?.term || '慢D'}有哪些常见误解？`]:state.view === 'explorer' ? ['解释当前条件的查询结果', '当前条件下有哪些完整出装？'] : state.libraryDocumentId?['解释这条规则的触发条件','这张表的概率对应什么条件？']:state.view==='augments'?['这个海克斯有哪些奖励？','什么时候会出现，与哪些强化互斥？']:state.view === 'mechanics' ? ['这个法杖有什么出现条件？', '给我这个法杖的玩法和适合阵容'] : state.view === 'stats' && state.explorer?.mode === 'builds' ? ['按当前条件最佳三件套是什么？', '解释当前组合的排序依据'] : state.view === 'stats' && state.statsTab === 'emblems' ? ['这枚转职适合谁携带？', '这枚转职有哪些可研究的阵容？'] : state.view === 'stats' ? ['大树最佳阵容和三件装备是什么？', '解释当前统计的排序依据'] : ['解释这条资料的效果', '它与哪些英雄或装备有配合？'];
  $('#chat-suggestions').replaceChildren(...suggestions.map(text => el('button', { type: 'button', onclick: () => { $('#chat-input').value = text; $('#chat-input').focus(); } }, text)));
}
function inlineMarkdown(text) {
  return String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).filter(Boolean).map(token => token.startsWith('**') && token.endsWith('**') ? el('strong', { text: token.slice(2, -2) }) : token.startsWith('`') && token.endsWith('`') ? el('code', { text: token.slice(1, -1) }) : document.createTextNode(token));
}
function markdownContent(text,visuals) {
  const container = el('div', { class: 'message-content markdown-content' });
  const tables=visuals?.version===1&&Array.isArray(visuals.tables)?visuals.tables:[];let tableIndex=0;
  for(const table of tables){const cards=renderChatCards(table,{el,lookup:byId,entityImage,openEntity});if(cards)container.append(cards);}
  const lines = String(text).split('\n'); let index = 0;
  const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').slice(0, 12).map(cell => cell.trim());
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const code = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      container.append(el('pre', {}, el('code', { text: code.join('\n') }))); continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) { container.append(el('h3', {}, inlineMarkdown(heading[1]))); index++; continue; }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
      const titles = tableCells(line); const table = el('table');
      table.append(el('thead', {}, el('tr', {}, titles.map(title => el('th', { scope: 'col' }, inlineMarkdown(title))))));
      const body = el('tbody'); index += 2; let rows = 0;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() && rows++ < 80) {
        const cells = tableCells(lines[index++]); body.append(el('tr', {}, titles.map((_, i) => el('td', {}, inlineMarkdown(cells[i] || '')))));
      }
      table.append(body);
      if(!tables[tableIndex++])container.append(el('div', { class: 'chat-table-scroll' }, table)); continue;
    }
    const unordered = /^\s*[-*+]\s+/.test(line); const ordered = /^\s*\d+[.)]\s+/.test(line);
    if (unordered || ordered) {
      const list = el(unordered ? 'ul' : 'ol'); const pattern = unordered ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
      while (index < lines.length && pattern.test(lines[index])) list.append(el('li', {}, inlineMarkdown(lines[index++].replace(pattern, ''))));
      container.append(list); continue;
    }
    container.append(el('p', {}, inlineMarkdown(line))); index++;
  }
  return container;
}
function citedChatEvidence(message) {
  const evidence = Array.isArray(message.evidence) ? message.evidence : [];
  const citedIds = new Set([...String(message.content || '').matchAll(/\[(S[1-9]\d*)\]/g)].map(match => match[1]));
  const cited = evidence.filter(entry => typeof entry?.id === 'string' && /^S[1-9]\d*$/.test(entry.id) && citedIds.has(entry.id));
  return cited.length ? cited : evidence;
}
function renderChat() {
  const log = $('#chat-log'); const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80; log.replaceChildren();
  if (!state.messages.length) log.append(el('div', { class: 'chat-message assistant' }, el('div', { class: 'message-meta' }, el('span', { text: '✧' }), el('b', { text: 'TFT助手' })), el('div', { class: 'message-content', text: '可以问我阵容、三件装备、转职搭配或法杖玩法。\n\n我会结合当前页面资料直接回答，并附上来源。' })));
  state.messages.forEach(message => {
    const node = el('article', { class: `chat-message ${message.role}` }, el('div', { class: 'message-meta' }, el('span', { text: '✧' }), el('b', { text: message.role === 'assistant' ? 'TFT助手' : '你' })), message.role === 'assistant' ? markdownContent(message.content,message.visuals) : el('div', { class: 'message-content', text: message.content }));
    if (message.evidence?.length) node.append(evidenceLinks(citedChatEvidence(message)));
    if (typeof message.traceId === 'string') node.append(el('div', { class: 'chat-actions' }, btn('查看这次回答的证据链', () => navigate('developer', message.traceId), 'ghost')));
    const actions = message.actions?.filter(action => ['open_entity', 'open_query'].includes(action.type)) || [];
    if (actions.length) node.append(el('div', { class: 'chat-actions' }, actions.map(action => el('button', { type: 'button', disabled: state.chatting, onclick: () => performAction(action) }, action.label || '查看资料'))));
    log.append(node);
  });
  if (state.chatting) log.append(el('div', { class: 'chat-message assistant' }, el('div', { class: 'message-meta' }, el('span', { class: 'spinner small' }), el('b', { text: 'TFT助手正在查阅资料…' }))));
  if (nearBottom || state.chatting) log.scrollTop = log.scrollHeight;
  renderAIStatus();
}
async function sendChat(event) {
  event?.preventDefault(); if (state.chatting) return;
  const input = $('#chat-input'); const content = input.value.trim(); if (!content) return;
  const version = state.draft.version;
  const draft = { ...freshDraft(), version };
  const explorer = state.view === 'stats' ? chatExplorerContext() : null;
  const previousQuery = [...state.messages].reverse().find(message => message.role === 'assistant' && message.queryState)?.queryState;
  const context = { rank:pageRank(), view: state.view, entityId: state.entityId, libraryDocumentId:state.libraryDocumentId, readonly: true, draftExcludedReason: 'research_only', ...(previousQuery ? { queryState: previousQuery } : {}), ...(state.view === 'explorer' ? { research: normalizeResearchQuery(state.research) } : {}), ...(state.view === 'stats' ? { statsTab: state.statsTab, ...(explorer ? { explorer } : {}) } : {}), ...(state.statEntity ? { statEntity: structuredClone(state.statEntity) } : {}), ...(state.mechanicEntity ? { mechanicEntity: structuredClone(state.mechanicEntity) } : {}) };
  state.messages.push({ role: 'user', content }); input.value = ''; state.chatting = true; renderChat();
  try {
    const result = await api('/api/chat', { language:getLanguage(), messages: state.messages.slice(-16).map(m => ({ role: m.role, content: m.content })), pageContext: context, draft }, Math.min(900000,(state.health?.ai?.inference?.turnTimeoutMs||240000)+(state.health?.ai?.inference?.requestTimeoutMs||120000)+30000));
    if (result.answerMode !== 'conditional_statistics' && typeof result.reply === 'string' && result.reply.trim()) {
      state.health = { ...(state.health || {}), ai: { ...(state.health?.ai || {}), configured: true, ready: true } };
    }
    state.messages.push({ role: 'assistant', visuals:result.visuals, answerMode: result.answerMode, queryState: result.queryState || null, content: str(result.reply, 'TFT助手没有返回回答内容。'), traceId: result.traceId, evidence: Array.isArray(result.evidence) ? result.evidence : [], actions: Array.isArray(result.suggestedActions) ? result.suggestedActions.filter(action => ['open_entity','open_query'].includes(action.type)) : [] });
  } catch (error) { state.messages.push({ role: 'assistant', traceId: error.traceId, content: `请求未完成：${error.message}\n\n请重试，或查看数据源状态。` }); }
  finally { state.chatting = false; renderChat(); updateChatContext(); }
}
function chatExplorerContext() {
  const query = state.explorer;
  if (!query) return null;
  const terms = values => Array.isArray(values) ? values.filter(value => value && ['champion', 'item', 'trait'].includes(value.type) && typeof value.id === 'string').slice(0, 32).map(({ type, id }) => ({ type, id })) : [];
  const row = query.selectedRow;
  const selectedRow = row && typeof row === 'object' ? Object.fromEntries(['id', 'kind', 'championId', 'itemId', 'traitId', 'unitIds', 'itemIds'].filter(key => typeof row[key] === 'string' || ['unitIds', 'itemIds'].includes(key) && Array.isArray(row[key])).map(key => [key, Array.isArray(row[key]) ? row[key].filter(value => typeof value === 'string').slice(0, 32) : row[key]])) : null;
  return { ...(query.mode === 'builds' ? { mode: 'builds' } : {}), tab: state.statsTab, perspective: query.perspective === 'item' ? 'item' : 'champion', include: terms(query.include), exclude: terms(query.exclude), operator: query.operator === 'any' ? 'any' : 'all', minSample: query.minSample, search: query.search, cost: query.cost, sort: query.sort, sortDirection: query.sortDirection, selectedRow, scope: 'cached_aggregate_rows' };
}
function performAction(action) {
  if (action.type === 'open_query' && action.query?.view === 'filter') {
    const checked = validateResearchQuery(action.query, state.catalog);
    if (!checked.valid) return toast(checked.reason, true);
    state.research = normalizeResearchQuery({ ...checked.query, dataSource: 'metatft' }); saveResearchQuery(); navigate('explorer'); return;
  }
  if (action.type === 'open_entity') {
    const type = ({ champion: 'champions', item: 'items', trait: 'traits', augment: 'augments' })[action.entityType] || action.entityType;
    if (!Object.hasOwn(TYPE_LABELS, type)) return toast('建议包含未支持的实体类型。', true); return openEntity(type, action.entityId);
  }
}
function reviewPatch(action, responseVersion) {
  if (Number(action.expectedVersion ?? responseVersion) !== state.draft.version) return toast('建议版本已过期。', true);
  let next;
  try {
    const patch = action.patch || {}; const allowed = ['units', 'components', 'completedItems', 'reserve', 'preferences'];
    next = normalizeDraft({ ...state.draft, ...Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key))) });
    if (catalogMissing(next)) throw new Error('建议包含当前版本中不存在的实体');
    if (new Set(next.units.map(u => u.instanceId)).size !== next.units.length) throw new Error('建议的棋子实例重复');
  } catch (error) { return toast(`无法应用建议：${error.message}`, true); }
  const diff = [`棋子：${state.draft.units.length} → ${next.units.length}`, `散件：${countValues(state.draft.components)} → ${countValues(next.components)}`, `成装：${countValues(state.draft.completedItems)} → ${countValues(next.completedItems)}`, `预留：${countValues(state.draft.reserve)} → ${countValues(next.reserve)}`];
  const details = next.units.map(u => `${entityName(byId('champions', u.championId))} · ${ROLE_LABELS[u.role]} · 优先级 ${u.priority} · 锁装 ${u.lockedItems.map(id => entityName(byId('items', id))).join('、') || '无'}`);
  openModal('审阅助理建议', el('div', {}, el('p', { class: 'modal-description', text: '应用后会生成新草案版本，并让现有规划和旧回答过期。' }), el('pre', { class: 'patch-preview', text: [...diff, '', ...details, '', `散件库存：${Object.entries(next.components).map(([id, qty]) => `${entityName(byId('items', id))}×${qty}`).join('、') || '无'}`, `已有成装：${Object.entries(next.completedItems).map(([id, qty]) => `${entityName(byId('items', id))}×${qty}`).join('、') || '无'}`, `预留散件：${Object.entries(next.reserve).map(([id, qty]) => `${entityName(byId('items', id))}×${qty}`).join('、') || '无'}`].join('\n') }), el('div', { class: 'actions' }, btn('保留当前草案', closeModal, 'ghost'), btn('应用这项建议', () => { if (responseVersion !== state.draft.version) { closeModal(); return toast('审阅期间草案已改变，请重新询问。', true); } closeModal(); const version = state.draft.version; state.draft = next; state.draft.version = version + 1; persistDraft(); renderMain(); renderChat(); updateChatContext(); toast('建议已应用到新草案。'); }, 'primary'))));
}
function showChat(visible = !state.chatVisible) {
  const wasVisible = state.chatVisible;
  state.chatVisible = visible;
  $('#assistant-panel').hidden = !visible;
  $('#chat-toggle').setAttribute('aria-expanded', String(visible));
  $('#chat-toggle').setAttribute('aria-label', visible ? '收起TFT助手' : '打开TFT助手');
  if (visible) $('#chat-input').focus({ preventScroll: true });
  else if (wasVisible) $('#chat-toggle').focus({ preventScroll: true });
}
function globalSearch() {
  const input = el('input', { type: 'search', placeholder: '搜索英雄、装备、海克斯、机制与术语…', 'aria-label': '搜索全部资料' }); const results = el('div', { class: 'search-results' });
  const all = Object.keys(TYPE_LABELS).flatMap(type => state.catalog[type].map(entity => ({ type, entity })));
  const update = () => {
    const docs=input.value.trim()?(state.library?.documents ?? []).filter(doc=>searchLibrary(doc,input.value)).slice(0,8):[];
    const wisps=input.value.trim()?(state.mechanics?.entries || []).filter(entry=>mechanicSearchText(entry).includes(input.value.normalize('NFKC').toLowerCase().replace(/\s/g,''))).slice(0,8):[];
    const terms=input.value.trim()?filterGlossaryEntries(state.glossary?.entries,input.value).slice(0,8):[];
    const found = all.filter(({ entity }) => searchMatches(entity, input.value)).slice(0, 35-docs.length-wisps.length-terms.length);
    results.replaceChildren(...terms.map(entry=>el('button',{class:'search-result',onclick:()=>openGlossaryEntry(entry)},el('span',{class:'entity-image',text:'字'}),el('span',{},el('strong',{text:entry.term}),el('small',{text:'通用术语 · 本项目整理'})),el('span',{text:'↗'}))),...wisps.map(entry=>el('button',{class:'search-result',onclick:()=>openMechanicDetail(entry)},entityImage(entry),el('span',{},el('strong',{text:entry.name}),el('small',{text:`法杖出现条件 · ${offeringPreview(entry).window}`})),el('span',{text:'↗'}))),...docs.map(doc=>el('button',{class:'search-result',onclick:()=>openLibraryDocument(doc)},el('span',{class:'entity-image',text:'▤'}),el('span',{},el('strong',{text:doc.title}),el('small',{text:'中文机制与奖励表'})),el('span',{text:'↗'}))),...found.map(({ type, entity }) => el('button', { class: 'search-result', onclick: () => { navigate(type); openEntity(type, entity.id); } }, entityImage(entity), el('span', {}, el('strong', { text: entityName(entity) }), el('small', { text: `${TYPE_LABELS[type]} · ${entity.id}` })), el('span', { text: '↗' }))));
    if (!found.length&&!docs.length&&!wisps.length&&!terms.length) results.append(el('p', { class: 'muted-text', text: '没有找到匹配资料。' }));
  };
  input.addEventListener('input', update); update(); openModal('找到你的下一步', el('div', {}, el('div', { class: 'modal-filters' }, input), results), 'Ctrl / Cmd + K · Esc 关闭');
}
function restoreLocal() {
  const restored = readLocal(STORAGE.draft, null);
  if (restored?.schemaVersion === 1) try { state.draft = normalizeDraft(restored.draft); state.draftContextKey = restored.contextKey || null; state.draftContext = restored.context || null; } catch { /* Keep a fresh valid draft. */ }
  const saved = readLocal(STORAGE.saved, []);
  if (Array.isArray(saved)) state.saved = saved.slice(0, 60).filter(x => x?.schemaVersion === 1 && x?.draft?.units && typeof x.id === 'string').flatMap(record => { try { return [{ ...record, draft: normalizeDraft(record.draft) }]; } catch { return []; } });
}
async function bootstrap() {
  history.replaceState(null, '', `${location.pathname}${location.search}#${state.view}`);
  if(state.view==='glossary')state.libraryDocumentId=null;
  if (state.view === 'explorer') readResearchQueryFromUrl();
  restoreLocal(); renderNav(); showChat(state.chatVisible); renderSuggestions(); renderChat(); updateChatContext();
  const results = await Promise.allSettled([api('/api/catalog'), api('/api/decks'), api('/api/sources'), api('/api/health'), api('/api/stats'), api('/api/library'), api('/api/mechanics'),api('/api/glossary')]);
  if (results[0].status === 'fulfilled') {
    const catalog = results[0].value.catalog || results[0].value;
    state.catalog = { ...catalog, context: catalog.context || {}, champions: Array.isArray(catalog.champions) ? catalog.champions : [], items: Array.isArray(catalog.items) ? catalog.items : [], traits: Array.isArray(catalog.traits) ? catalog.traits : [], augments: Array.isArray(catalog.augments) ? catalog.augments : [] };
    for(const category of ['champions','items','traits','augments'])for(const entity of state.catalog[category])entity.aliases=[...new Set([...(entity.aliases||[]),englishText(entity.name)])];
    const restored = readLocal(STORAGE.draft, null);
    if (!restored?.contextKey || restored.contextKey === contextKey()) { state.draftContextKey = contextKey(); state.draftContext = structuredClone(state.catalog.context); }
  } else state.catalogError = results[0].reason.message;
  if (results[1].status === 'fulfilled') state.decks = results[1].value; else state.decks = { status: 'unavailable', data: [], reason: results[1].reason.message };
  if (results[2].status === 'fulfilled') state.sources = results[2].value;
  if (results[3].status === 'fulfilled') state.health = results[3].value;
  if (results[4].status === 'fulfilled') state.statsOverview = results[4].value; else state.statsError = results[4].reason.message;
  if(results[5].status==='fulfilled')state.library=results[5].value;else state.library={status:'not_cached',documents:[],augmentRules:[],reason:results[5].reason.message};
  if(results[6].status==='fulfilled')state.mechanics=results[6].value;
  if(results[7].status==='fulfilled')state.glossary=results[7].value;else state.glossary={entries:[],reason:results[7].reason.message};
  renderContext(); renderMain(); renderAIStatus(); updateChatContext();
  if (['mechanics','wisp-rules'].includes(state.view) && !state.mechanics) loadMechanics();
}
$('#chat-form').addEventListener('submit', sendChat);
$('#chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat(); } });
$('#chat-toggle').addEventListener('click', () => showChat());
$('#chat-expand')?.addEventListener('click',()=>{const wide=$('#assistant-panel').classList.toggle('expanded');$('#chat-expand').textContent=wide?'缩小':'展开';$('#chat-expand').setAttribute('aria-expanded',String(wide));});
$('#chat-close').addEventListener('click', () => showChat(false));
$('#chat-model-settings')?.addEventListener('click',async()=>{if(state.chatting)return toast('等待当前回答完成后再修改模型。');try{await openModelSettings({api,el,openModal,onSaved:async()=>{state.health=await api('/api/health');renderAIStatus();}});}catch(e){toast(e.message,true);}});
$('#chat-clear').addEventListener('click', () => { if (state.chatting) return toast('等待当前回答完成后再清空。'); state.messages = []; renderChat(); toast('聊天已清空。'); });
$('#global-search').addEventListener('click', globalSearch);
$('#menu-toggle').addEventListener('click', () => { const open = $('#sidebar').classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', String(open)); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
$('#sidebar .brand').addEventListener('click', event => { event.preventDefault(); navigate('comps'); });
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const rect = $('#modal').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal(); } });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); globalSearch(); } if (event.key === 'Escape') { $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); if (state.chatVisible && !$('#modal').open) showChat(false); } });
window.addEventListener('hashchange', () => navigate(visibleRoute(location.hash.slice(1))));
window.addEventListener('beforeunload', event => {
  if (state.view === 'team-planner' && state.plannerController?.hasUnsavedChanges()) {
    event.preventDefault(); event.returnValue = '';
  }
});
initAppearance();
await initLanguage();
bootstrap();
watchStatistics({api,onChange:()=>{
  invalidateComps();invalidateStats();
  if(state.catalog&&['comps','stats'].includes(state.view))renderMain();
  if(state.view==='explorer')toast('统计数据有更新，可重新查询当前条件。');
}});
