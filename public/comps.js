import { pageRank, rankPicker, rankLabel } from './stat-ranks.js';
import { renderTftBoard } from './tft-board.js';
import { patchContext, patchDetails } from './patch-context.js';
import { buildExplorerIndex, searchExplorerEntities } from './explorer-search.js';

const session = { data: null, error: '', pending: null, selectedId: null, search: '', sort: 'source', contextKey: '', requestGeneration: 0 };
let mountSequence = 0;
export function invalidateComps(){session.requestGeneration++;session.data=null;session.pending=null;session.error='';}
const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const itemId = value => typeof value === 'string' ? value : value?.id || value?.itemId;

function element(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = value;
    else if (key === 'value') node.value = value;
    else if (key === 'disabled') node.disabled = Boolean(value);
    else if (key === 'selected') node.selected = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  const add = child => {
    if (Array.isArray(child)) return child.forEach(add);
    if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(add); return node;
}

const button = (label, action, className = '', disabled = false) => element('button', { type: 'button', class: `comps-button ${className}`, text: label, onclick: action, disabled });
function safeURL(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
function date(value) { if (!value) return '未知'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '未知' : d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function number(value, digits = 2) { return finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—'; }
function percent(value) { return finite(value) && value >= 0 && value <= 1 ? `${(value * 100).toFixed(1)}%` : '—'; }
function count(value) { return finite(value) && value >= 0 ? value.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : '—'; }
function contextKey(context) { return [context?.set, context?.assetVersion, context?.rulesVersion, context?.mutator].join('|'); }
function portrait(entity, className, fallbackName = '') {
  const src = safeURL(entity?.icon);
  return src ? element('img', { class: className, src, alt: '', loading: 'lazy', decoding: 'async', onerror: event => { event.target.hidden = true; } }) : element('span', { class: `${className} comps-image-fallback`, text: (entity?.name || fallbackName || '?').slice(0, 1), 'aria-hidden': 'true' });
}

function normalUnits(deck) {
  return list(deck?.units).map((unit, index) => ({ instanceId: unit.instanceId || `comp:${String(deck?.id ?? 'source')}:${index}`, championId: unit.championId || unit.id, items: list(unit.items).map(itemId).filter(Boolean), cell: unit.cell ?? null, star: unit.star }));
}

function statsBar(stats, compact = false) {
  const values = [['平均名次', number(stats?.avgPlacement)], ['前四率', percent(stats?.top4Rate)], ['登顶率', percent(stats?.winRate)], ['阵容样本', count(stats?.sampleSize)]];
  return element('div', { class: `comps-metrics${compact ? ' compact' : ''}` }, values.map(([label, value]) => element('div', {}, element('span', { text: label }), element('strong', { text: value }))));
}

function sourceVersion(context, evidence) {
  const patch = patchContext(evidence);
  return element('div', { class: 'comps-context-tags' }, element('span', { text: context?.set != null ? `赛季 ${context.set}` : '赛季未知' }), context?.assetVersion ? element('span', { text: `资源 ${context.assetVersion}` }) : null, element('span', { class: patch.patch ? '' : 'unknown', text: `统计补丁 ${patch.label}` }));
}

function evidenceBlock(evidence = {}, delivery) {
  const url = safeURL(evidence.url || evidence.endpoint);
  const sourceName = (evidence.stale ? '数据较旧 · ' : '') + (evidence.source || '来源未提供');
  return element('div', { class: 'comps-evidence' }, element('div', { class: 'comps-evidence-heading' }, element('span', { class: 'comps-source-mark', text: '↗' }), url ? element('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: sourceName }) : element('strong', { text: sourceName }), element('span', { class: 'comps-cache-label', text: delivery === 'mysql' || evidence.delivery === 'mysql' ? '数据库快照' : delivery === 'version_cache' || evidence.delivery === 'version_cache' ? '本地版本缓存' : '来源资料' })), element('dl', { class: 'comps-source-facts' }, element('div', {}, element('dt', { text: '来源时间' }), element('dd', { text: date(evidence.sourceTime) })), element('div', {}, element('dt', { text: '采集时间' }), element('dd', { text: date(evidence.fetchedAt) })), element('div', {}, element('dt', { text: '统计补丁' }), element('dd', { text: patchContext(evidence).label }))), patchDetails(evidence), element('p', { class: 'comps-source-note', text: evidence.statisticsKind === 'comp_cluster' ? `普通排位 · ${evidence.rank || '段位未知'} · 近 3 天。指标属于阵容体系，包含不同变体；代表配置的装备不构成固定三件套联合统计。` : '样本为来源中匹配这套阵容的记录。资源版本与统计补丁分别标示；推定补丁不代表来源已确认统计窗口。' }));
}

export function roster(units, catalog, compact = false) {
  const champions = new Map(list(catalog?.champions).map(entity => [entity.id, entity]));
  const items = new Map(list(catalog?.items).map(entity => [entity.id, entity]));
  return element('div', { class: compact ? 'comps-card-roster' : 'comps-roster' }, list(units).map(unit => {
    const champion = champions.get(unit.championId || unit.id) || unit;
    const star = Number.isInteger(unit.star) && unit.star >= 1 && unit.star <= 3 ? unit.star : null;
    const itemIcons = element('div', { class: 'comps-roster-items' }, list(unit.items).map(value => { const item = items.get(itemId(value)); return element('span', { class: 'comps-equipment', title: item?.name || '装备资料未收录', 'aria-label': item?.name || '装备资料未收录' }, portrait(item, 'comps-equipment-image')); }));
    if (compact) return element('div', { class: `comps-mini-unit${finite(champion?.cost) ? ` cost-${champion.cost}` : ''}${unit.isCore ? ' core' : ''}`, title: `${champion.name || '未收录英雄'}${unit.isCore ? ' · 来源核心' : ''}${star ? ` · ${star} 星` : ''}` }, portrait(champion, 'comps-mini-portrait'), star ? element('span', { class: 'comps-mini-stars', text: '★'.repeat(star) }) : null, itemIcons, element('span', { class: 'comps-mini-name', text: champion.name || '未收录英雄' }));
    const cell = unit.cell; const valid = cell && Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 1 && cell.x <= 7 && cell.y >= 1 && cell.y <= 4;
    return element('div', { class: `comps-roster-unit${finite(champion?.cost) ? ` cost-${champion.cost}` : ''}` }, portrait(champion, 'comps-roster-portrait'), element('div', { class: 'comps-roster-copy' }, element('strong', { text: champion.name || '未收录英雄' }), element('small', { text: `${finite(champion.cost) ? `${champion.cost} 费` : '费用未知'}${star ? ` · ${star} 星` : ' · 星级未提供'}${unit.isCore ? ' · 来源核心' : ''}` })), element('span', { class: `comps-roster-coordinate${valid ? '' : ' unknown'}`, text: valid ? `(${cell.x}, ${cell.y})` : cell == null ? '未提供站位' : '坐标待核对', title: valid ? `从左起第 ${cell.x} 列 · 第 ${cell.y} 排` : '未改动来源坐标' }), itemIcons);
  }));
}

function sourceTraits(deck, catalog) {
  const traits = new Map(list(catalog?.traits).map(trait => [trait.id, trait]));
  return element('div', { class: 'comps-source-traits' }, list(deck.traits).map(trait => {
    const entity = traits.get(trait.id) || trait;
    return element('span', { class: 'comps-trait', title: entity.description || entity.name || '羁绊资料未收录' }, portrait(entity, 'comps-trait-icon'), element('strong', { text: finite(trait.count) ? count(trait.count) : '—' }), element('span', { text: entity.name || '未收录羁绊' }));
  }));
}

function sortDecks(decks, sort) {
  const rows = [...decks];
  if (sort === 'source') return rows;
  const field = sort === 'sample' ? 'sampleSize' : sort === 'top4' ? 'top4Rate' : 'avgPlacement';
  return rows.sort((a, b) => {
    const aa = a.stats?.[field]; const bb = b.stats?.[field];
    if (!finite(aa)) return finite(bb) ? 1 : 0;
    if (!finite(bb)) return -1;
    return (sort === 'avg' ? aa - bb : bb - aa) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });
}

/** Mount the source comp list without touching the surrounding chat or user draft. */
export function renderComps(main, { catalog, api, onEdit, toast, initialCompId = null } = {}) {
  const mount = ++mountSequence; let rank=pageRank(); const key = contextKey(catalog?.context)+'|'+rank;
  const searchIndex = buildExplorerIndex(catalog);
  session.selectedId = initialCompId;
  if (session.contextKey !== key) {
    session.contextKey = key; session.requestGeneration += 1; session.data = null; session.pending = null; session.error = ''; session.selectedId = initialCompId;
  }
  const page = element('div', { class: 'comps-page' }); main.replaceChildren(page);
  let paint = 0;
  const alive = () => mount === mountSequence && page.isConnected;
  function load(force = false) {
    if (force) { session.requestGeneration += 1; session.data = null; session.error = ''; session.pending = null; }
    if (session.data || session.pending) return;
    const generation = session.requestGeneration;
    const request = Promise.resolve().then(() => { if (typeof api !== 'function') throw new Error('阵容 API 未连接。'); return api(`/api/comps/v2?rank=${rank}`); }).then(result => {
      if (generation === session.requestGeneration) { session.data = result && typeof result === 'object' ? result : { status: 'unavailable', data: [], reason: '阵容来源未返回可读取内容。' }; session.error = ''; }
    }, error => { if (generation === session.requestGeneration) session.error = error.message || '来源阵容读取失败。'; }).finally(() => {
      if (session.pending === request) session.pending = null;
      if (alive() && generation === session.requestGeneration) render();
    });
    session.pending = request;
  }
  function open(deck) { session.selectedId = deck.id; render(); page.querySelector('h1')?.focus({ preventScroll: true }); }
  function back() { session.selectedId = null; render(); page.querySelector('h1')?.focus({ preventScroll: true }); }
  function edit(deck) {
    if (typeof onEdit !== 'function') return;
    try { onEdit(deck); } catch (error) { toast?.(error.message || '个人规划暂时无法打开。'); }
  }
  async function copySourceCode(code) {
    try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(code); toast?.('已复制来源阵容码。'); }
    catch { toast?.('无法自动复制；展开下方来源阵容码并手动复制。'); }
  }
  function render() {
    if (!alive()) return;
    paint += 1; const thisPaint = paint;
    const data = session.data; const decks = list(data?.data);
    const selected = session.selectedId != null ? decks.find(deck => String(deck.id) === String(session.selectedId)) : null;
    if (selected) return renderDetail(selected, data);
    const heading = element('header', { class: 'comps-page-heading' }, element('div', {}, element('span', { class: 'comps-eyebrow', text: 'TEAM COMPOSITIONS' }), element('h1', { text: '阵容推荐', tabindex: '-1' }), element('p', { text: '从来源阵容出发，看队员、装备与站位，再建立自己的规划。' })), element('span', { class: 'comps-top-label', text: data?.delivery === 'version_cache' || data?.evidence?.delivery === 'version_cache' ? '当前版本缓存' : '来源阵容' }));
    page.replaceChildren(heading);
    if (!data) {
      if (session.error) page.append(element('div', { class: 'comps-empty error' }, element('h2', { text: '阵容暂时无法读取' }), element('p', { text: session.error }), button('重新读取', () => { load(true); render(); }, 'secondary')));
      else page.append(element('div', { class: 'comps-empty', role: 'status' }, element('span', { class: 'spinner' }), element('p', { text: '正在读取本地来源阵容…' })));
      return;
    }
    page.append(sourceVersion(data.context || catalog?.context, data.evidence));
    if (data.evidence?.statisticsKind === 'comp_cluster') page.append(element('p', {class:'comps-source-note',text:`MetaTFT · 普通排位 · ${data.evidence.rank || '段位未知'} · 近 3 天。指标统计各阵容体系的不同变体；下列棋子和装备为来源代表配置。`}));
    if (!decks.length || !['cached', 'live', 'ready'].includes(data.status)) {
      page.append(element('div', { class: 'comps-empty' }, element('h2', { text: data.status === 'not_cached' ? '当前版本尚未收录阵容' : '来源阵容暂不可用' }), element('p', { text: data.reason || '没有可展示的来源阵容；不会生成替代阵容或统计。' }), button('重新读取本地资料', () => { load(true); render(); }, 'secondary')));
      return;
    }
    const search = element('input', { type: 'search', value: session.search, placeholder: '搜索阵容、队员或羁绊…', 'aria-label': '搜索来源阵容' });
    const sort = element('select', { 'aria-label': '来源阵容排序', onchange: event => { session.sort = event.target.value; updateGrid(); } }, [['source', data.evidence?.statisticsKind === 'comp_cluster' ? '热门体系（样本数）' : '来源顺序'], ['avg', '平均名次 ↑'], ['top4', '前四率 ↓'], ['sample', '样本数 ↓']].map(([value, text]) => element('option', { value, text, selected: session.sort === value })));
    const counter = element('span', { class: 'comps-result-count' }); const grid = element('div', { class: 'comps-grid' });
    search.addEventListener('input', event => { session.search = event.target.value; updateGrid(); });
    page.append(element('div', { class: 'comps-toolbar' }, rankPicker(rank,value=>{rank=value;session.contextKey=contextKey(catalog?.context)+'|'+rank;session.selectedId=null;load(true);render();},'阵容统计段位'), element('div', { class: 'comps-search' }, element('span', { text: '⌕', 'aria-hidden': 'true' }), search), sort, counter, button('刷新阵容', () => {load(true); render();}, 'secondary')), grid, element('footer', { class: 'comps-list-footer' }, evidenceBlock(data.evidence, data.delivery)));
    function updateGrid() {
      if (!alive() || thisPaint !== paint) return;
      const query = session.search.trim().toLowerCase();
      const aliases = deck => list(deck.units).flatMap(unit => list(catalog?.champions?.find(entity=>entity.id===unit.id)?.aliases));
      const heroMatches = new Set(searchExplorerEntities(searchIndex,query,'champion').map(({entity})=>entity.id));
      const matches = sortDecks(decks.filter(deck => [deck.name, ...aliases(deck), ...list(deck.units).map(unit => unit.name || catalog?.champions?.find(entity => entity.id === unit.id)?.name), ...list(deck.traits).map(trait => trait.name)].join(' ').toLowerCase().includes(query) || query && list(deck.units).some(unit=>heroMatches.has(unit.id))), session.sort);
      counter.textContent = `${matches.length} / ${decks.length} 套来源阵容`;
      grid.replaceChildren(...matches.map(deck => element('button', { type: 'button', class: 'comps-card', onclick: () => open(deck), 'aria-label': `查看${deck.name || '来源阵容'}的队员、装备、站位与统计` }, element('div', { class: 'comps-card-heading' }, element('strong', { class: 'comps-card-title', text: deck.name || '来源阵容' }), element('span', { class: 'comps-card-arrow', text: '↗', 'aria-hidden': 'true' })), roster(deck.units, catalog, true), sourceTraits(deck, catalog), statsBar(deck.stats, true), element('div', { class: 'comps-card-bottom' }, element('span', { text: `来源 · ${deck.evidence?.source || data.evidence?.source || '来源未提供'}` }), element('span', { text: '查看完整阵容 →' })))));
      if (!matches.length) grid.append(element('div', { class: 'comps-empty' }, element('h2', { text: '没有匹配的来源阵容' }), element('p', { text: '尝试阵容名、英雄名或羁绊名。' })));
    }
    updateGrid();
  }
  function renderDetail(deck, data) {
    const units = normalUnits(deck); const evidence = { ...data.evidence, ...deck.evidence };
    const providedCount = units.filter(unit => unit.cell && Number.isInteger(unit.cell.x) && Number.isInteger(unit.cell.y) && unit.cell.x >= 1 && unit.cell.x <= 7 && unit.cell.y >= 1 && unit.cell.y <= 4).length;
    const cluster = deck.statisticsKind === 'comp_cluster';
    const sourceCode = typeof deck.teamCode === 'string' && deck.teamCode.trim() ? deck.teamCode : null;
    page.replaceChildren(element('div', { class: 'comps-detail-navigation' }, button('← 返回阵容', back, 'ghost'), element('span', { text: '来源阵容详情' })), element('header', { class: 'comps-page-heading detail' }, element('div', {}, element('span', { class: 'comps-eyebrow', text: 'SOURCE LINEUP' }), element('h1', { text: deck.name || '来源阵容', tabindex: '-1' }), sourceVersion(data.context || catalog?.context, evidence)), element('div', { class: 'comps-header-actions' }, sourceCode ? button('复制来源阵容码', () => copySourceCode(sourceCode), 'secondary') : null, button('编辑为个人规划 ↗', () => edit(deck), 'primary', typeof onEdit !== 'function'))));
    const boardPanel = element('section', { class: 'comps-panel comps-board-panel' }, element('div', { class: 'comps-panel-heading' }, element('h2', { text: '来源站位' }), element('span', { text: '4 × 7 棋盘' })), providedCount === 0 ? element('p', { class: 'comps-position-warning', text: '来源未提供这套阵容的站位坐标；全部棋子列在未摆放区。' }) : null, list(deck.warnings).filter(warning => warning.code !== 'source_position_missing').map(warning => element('p', { class: 'comps-position-warning', text: warning.message || '部分来源坐标需核对。' })), renderTftBoard({ units, catalog }), element('p', { class: 'comps-board-note', text: cluster ? '此阵容体系目录未提供完整站位；未将单个棋子的位置分布拼成一套真实站位。可编辑为个人规划后自行摆放。' : '沿用 OP.GG 已核验的坐标：左到右为 1—7，第 4 排为前排，第 1 排为后排。缺失或无效坐标保持待摆放。' }));
    const infoPanel = element('aside', { class: 'comps-detail-info' }, element('section', { class: 'comps-panel' }, element('div', { class: 'comps-panel-heading' }, element('h2', { text: cluster ? '阵容体系统计' : '这套阵容的统计' })), statsBar(deck.stats), element('p', { class: 'comps-source-note', text: deck.note || '统计描述这套来源阵容的样本，不代表改人、换装或改变站位后的胜率。' })), element('section', { class: 'comps-panel' }, evidenceBlock(evidence, data.delivery)));
    page.append(element('div', { class: 'comps-detail-grid' }, boardPanel, infoPanel), element('section', { class: 'comps-panel comps-summary-panel' }, element('div', { class: 'comps-source-summary' }, element('div', { class: 'comps-source-population', title: deck.population?.note || '' }, element('strong', { text: deck.population?.requiredSlots ?? '未知' }), element('span', { text: '所需基础人口' }), element('small', { text: `${units.length} 名棋子 · 来源坐标 ${providedCount} · 待摆放 ${units.length - providedCount}` })), element('div', { class: 'comps-source-trait-group' }, element('h2', { text: '来源标示羁绊' }), list(deck.traits).length ? sourceTraits(deck, catalog) : element('p', { class: 'comps-source-note', text: '来源未提供羁绊计数。' }))), element('p', { class: 'comps-source-note', text: cluster ? '基础人口按代表名单及当前目录规则计算，不是来源最终等级。羁绊数字表示来源所列档位的起始人数，不是实际人数。' : '基础人口按当前目录规则计算，含远古巨龙两栏；未计额外容量，不推断来源最终等级。羁绊计数沿用这套来源阵容。' })), element('section', { class: 'comps-panel' }, element('div', { class: 'comps-panel-heading' }, element('h2', { text: '棋子与装备' }), element('span', { text: cluster ? '来源代表配置 · 星级与站位未提供' : '坐标沿用来源' })), roster(deck.units, catalog)));
    const stages = list(deck.stages);
    if (stages.length) page.append(element('section', { class: 'comps-panel' }, element('div', { class: 'comps-panel-heading' }, element('h2', { text: '来源阶段示例' }), element('span', { text: '非运营指南' })), element('p', { class: 'comps-source-note', text: '以下是来源提供的棋盘示例。未给出的经济、搜牌和升级过程保持未知；不附用最终阵容胜率。' }), element('div', { class: 'comps-stage-grid' }, stages.map((stage, index) => element('details', { class: 'comps-stage' }, element('summary', {}, element('strong', { text: `${({ early: '前期', middle: '中期', late: '后期' })[stage.stage] || stage.name || '阶段'} · 来源示例` }), finite(stage.level) ? element('span', { text: `来源等级 ${stage.level}` }) : null), renderTftBoard({ units: normalUnits({ id: `${deck.id}:stage:${index}`, units: stage.units }), catalog, compact: true }), roster(stage.units, catalog, true), typeof stage.play === 'string' && stage.play.trim() ? element('p', { class: 'comps-stage-text', text: stage.play }) : null)))));
    const variants = list(deck.variants).filter(variant => list(variant?.units).length && variant.stats && variant.id != null);
    if (variants.length) page.append(element('section', { class: 'comps-panel' }, element('div', { class: 'comps-panel-heading' }, element('h2', { text: '相关来源阵容 · 各自独立统计' })), element('p', { class: 'comps-source-note', text: '按共有核心与较小名单至少50%重叠关联；来源未标示同族变阵。每套阵容保留自己的完整队员与统计，不推断换人后的胜率收益。' }), element('div', { class: 'comps-variants' }, variants.map(variant => element('button', { type: 'button', class: 'comps-variant comps-related-card', onclick: () => open(decksById(variant.id) || variant), 'aria-label': `查看相关来源阵容${variant.name || ''}的独立完整详情` }, element('div', { class: 'comps-related-title' }, element('strong', { text: variant.name || '相关来源阵容' }), element('span', { text: '↗' })), roster(variant.units, catalog, true), statsBar(variant.stats, true))))));
    if (sourceCode) page.append(element('details', { class: 'comps-source-code' }, element('summary', { text: '查看来源阵容码' }), element('textarea', { rows: 3, readonly: 'true', value: sourceCode, 'aria-label': '来源阵容码', onfocus: event => event.target.select() }), element('p', { class: 'comps-source-note', text: '沿用这套来源阵容码，不包含个人修改。' })));
    page.append(element('div', { class: 'comps-detail-bottom' }, button('← 返回全部阵容', back, 'secondary'), button('编辑为个人规划', () => edit(deck), 'primary', typeof onEdit !== 'function')));
    function decksById(id) { return list(data.data).find(row => String(row.id) === String(id)); }
  }
  load(); render();
  if (session.pending) session.pending.then(() => { if (alive()) render(); });
  return page;
}
