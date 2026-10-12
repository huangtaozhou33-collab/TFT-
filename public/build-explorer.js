import { normalizeBuildQuery, buildQueryFromExplorer } from './build-query.js';
import { searchExplorerEntities } from './explorer-search.js';

const METRICS = [['avgPlacement', '平均名次 · 越低越好'], ['top4Rate', '前四率 · 越高越好'], ['winRate', '登顶率 · 越高越好'], ['sampleSize', '样本数 · 越多越好']];
const number = (value, rate = false) => typeof value !== 'number' || !Number.isFinite(value) ? '—' : rate ? `${(value * 100).toFixed(1)}%` : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

export function renderBuildExplorer(main, host) {
  const { el, btn, image, catalog, index, query, api, onChange, onRecords, onSave, onShare, onAsk, formatTime } = host;
  const itemById = new Map(catalog.items.map(item => [item.id, item]));
  const championById = new Map(catalog.champions.map(champion => [champion.id, champion]));
  const getQuery = () => buildQueryFromExplorer(query) || normalizeBuildQuery({});
  let itemTarget = 'include', request = 0;
  const page = el('div', { class: 'build-explorer' }); main.append(page);
  page.append(el('header', { class: 'build-page-heading' }, el('div', {}, el('p', { class: 'build-eyebrow', text: '数据检索器 / 条件出装' }), el('h1', { text: '先定条件，再选三件套。' }), el('p', { text: '指定一名英雄，把已有装备固定下来，比较满足条件的完整出装。' })), btn('总体与其他统计 ↗', onRecords, 'secondary')));
  const controls = el('section', { class: 'build-controls', 'aria-label': '条件出装设置' }); page.append(controls);
  const heroSelected = el('div', { class: 'build-selected-hero' });
  const heroSuggestions = el('div', { class: 'build-suggestions', role: 'listbox', 'aria-label': '选择出装英雄' });
  const heroInput = el('input', { type: 'search', placeholder: '英雄名称、外号、拼音，例如：小法', 'aria-label': '搜索出装英雄', autocomplete: 'off', oninput: () => suggest(heroInput, heroSuggestions, 'champion', entity => {
    query.include = [{ type: 'champion', id: entity.id }, ...query.include.filter(term => term.type === 'item')];
    heroInput.value = ''; heroSuggestions.replaceChildren(); changed();
  }), onkeydown: event => listKeys(event, heroSuggestions) });
  controls.append(el('div', { class: 'build-hero-field' }, el('h2', { text: '01 / 选择英雄' }), heroSelected, heroInput, heroSuggestions));
  const itemChips = el('div', { class: 'build-fixed-slots', 'aria-label': '固定装备槽' });
  const excludeChips = el('div', { class: 'build-excluded-items', 'aria-label': '排除装备' });
  const itemSuggestions = el('div', { class: 'build-suggestions', role: 'listbox', 'aria-label': '选择条件装备' });
  const requiredButton = btn('＋ 固定装备', () => setTarget('include'), 'small');
  const excludedButton = btn('− 排除装备', () => setTarget('exclude'), 'small');
  const itemInput = el('input', { type: 'search', placeholder: '搜索要固定的装备，例如：黎明核心、法爆', 'aria-label': '搜索条件装备', autocomplete: 'off', oninput: () => suggest(itemInput, itemSuggestions, 'item', entity => {
    if (entity.kind === 'component') return;
    const terms = query[itemTarget];
    if (!terms.some(term => term.type === 'item' && term.id === entity.id)) {
      if (itemTarget === 'include' && terms.filter(term => term.type === 'item').length >= 3) return;
      terms.push({ type: 'item', id: entity.id });
    }
    itemInput.value = ''; itemSuggestions.replaceChildren(); changed();
  }), onkeydown: event => listKeys(event, itemSuggestions) });
  controls.append(el('div', { class: 'build-items-field' }, el('h2', { text: '02 / 固定或排除装备' }), itemChips,
    el('div', { class: 'build-target-buttons' }, requiredButton, excludedButton), itemInput, itemSuggestions, excludeChips));
  const minimum = el('input', { type: 'number', min: 0, max: 100000000, value: query.minSample, 'aria-label': '条件出装最低样本', oninput: event => {
    if (event.target.value === '') return;
    query.minSample = normalizeBuildQuery({ minSample: event.target.value }).minSample; changed();
  }, onchange: event => {
    query.minSample = normalizeBuildQuery({ minSample: event.target.value }).minSample; event.target.value = query.minSample; changed();
  } });
  const sort = el('select', { 'aria-label': '条件出装排序指标', onchange: event => {
    query.sort = event.target.value; query.sortDirection = query.sort === 'avgPlacement' ? 'asc' : 'desc'; changed();
  } }, METRICS.map(([id, name]) => el('option', { value: id, selected: query.sort === id, text: name })));
  const exampleChampion = catalog.champions.find(champion => /Veigar$/i.test(champion.id));
  const exampleItem = catalog.items.find(item => /Dawncore$/i.test(item.id));
  controls.append(el('div', { class: 'build-settings' }, el('label', {}, '最低样本', minimum), el('label', {}, '排序依据', sort),
    el('div', { class: 'build-query-actions' }, exampleChampion && exampleItem ? btn('试试：小法＋黎明核心', () => {
      query.include = [{ type: 'champion', id: exampleChampion.id }, { type: 'item', id: exampleItem.id }]; query.exclude = [];
      query.minSample = 100; query.sort = 'avgPlacement'; query.sortDirection = 'asc'; minimum.value = 100; sort.value = 'avgPlacement'; changed();
    }, 'secondary small') : null, btn('保存查询', onSave, 'ghost small'), btn('分享', onShare, 'ghost small'))));
  const results = el('section', { class: 'build-results', 'aria-label': '条件出装结果', 'aria-live': 'polite' }); page.append(results);

  function listKeys(event, list) {
    if (event.key === 'Escape') list.replaceChildren();
    if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('button')?.focus(); }
    if (event.key === 'Enter' && list.querySelector('button')) { event.preventDefault(); list.querySelector('button').click(); }
  }
  function suggest(input, list, type, select) {
    list.replaceChildren();
    if (!input.value.trim()) return;
    const matches = searchExplorerEntities(index, input.value, type).filter(({ entity }) => type !== 'item' || entity.kind !== 'component').slice(0, 9);
    list.append(...matches.map(({ entity }) => el('button', { type: 'button', role: 'option', 'aria-label': entity.name, onclick: () => select(entity), onkeydown: event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const all = [...list.children]; all[(all.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length].focus(); }
      if (event.key === 'Escape') { list.replaceChildren(); input.focus(); }
    } }, image(entity), el('span', { text: entity.name }))));
    if (!matches.length) list.append(el('p', { text: '没有匹配的当前赛季实体。' }));
  }
  function setTarget(target) {
    itemTarget = target; requiredButton.classList.toggle('active', target === 'include'); excludedButton.classList.toggle('active', target === 'exclude');
    requiredButton.setAttribute('aria-pressed', String(target === 'include')); excludedButton.setAttribute('aria-pressed', String(target === 'exclude'));
    itemInput.placeholder = target === 'include' ? '搜索要固定的装备，例如：黎明核心、法爆' : '搜索不想使用的装备，例如：科技枪';
    itemInput.disabled = target === 'include' && query.include.filter(term => term.type === 'item').length >= 3;
  }
  function chips() {
    const champion = championById.get(getQuery().championId);
    heroSelected.replaceChildren(...(champion ? [image(champion), el('strong', { text: champion.name }), el('span', { text: `${champion.cost} 费` })] : [el('span', { text: '先选择一名英雄' })]));
    const fixed = query.include.filter(term => term.type === 'item');
    itemChips.replaceChildren(...[0, 1, 2].map(i => {
      const term = fixed[i], item = itemById.get(term?.id);
      return item ? el('div', { class: 'build-fixed-chip' }, image(item), el('div', {}, el('small', { text: '固定' }), el('strong', { text: item.name })), el('button', { type: 'button', 'aria-label': `取消固定${item.name}`, text: '×', onclick: () => { query.include = query.include.filter(value => value !== term); changed(); } }))
        : el('div', { class: 'build-open-slot' }, el('span', { text: `装备槽 ${i + 1}` }), el('small', { text: '由统计组合补齐' }));
    }));
    excludeChips.replaceChildren(...query.exclude.map(term => {
      const item = itemById.get(term.id); return el('span', { class: 'build-excluded-chip' }, el('span', { text: `排除 ${item?.name || term.id}` }), el('button', { type: 'button', 'aria-label': `取消排除${item?.name || term.id}`, text: '×', onclick: () => { query.exclude = query.exclude.filter(value => value !== term); changed(); } }));
    }));
    setTarget(itemTarget);
  }
  function changed() {
    query.page = 1; query.operator = 'all'; query.search = ''; query.cost = ''; query.selectedRow = null; onChange(); chips(); load();
  }
  async function load() {
    const current = getQuery(), ticket = ++request;
    if (!current.championId) { results.replaceChildren(el('div', { class: 'build-empty' }, el('span', { class: 'build-empty-mark', text: '01 → 02 → 03' }), el('h2', { text: '选英雄，锁装备，看完整组合。' }), el('p', { text: '例如：小法固定黎明核心，查询其余两件怎样搭配。' }))); return; }
    const key = JSON.stringify(current);
    if (query.buildResultKey === key && query.buildResult) return showResult(query.buildResult);
    results.replaceChildren(el('div', { class: 'build-empty', role: 'status' }, el('span', { class: 'spinner small' }), el('p', { text: '正在比较满足条件的完整三件套…' })));
    try {
      const result = await api('/api/builds/query', current);
      if (ticket !== request || !page.isConnected) return;
      query.buildResultKey = key; query.buildResult = result; showResult(result);
    } catch (error) { if (ticket === request && page.isConnected) results.replaceChildren(el('div', { class: 'build-empty' }, el('h2', { text: '出装查询未完成' }), el('p', { text: error.message }), btn('重试', load, 'secondary'))); }
  }
  function equipment(row, compact = false) {
    return el('div', { class: compact ? 'build-equipment compact' : 'build-equipment' }, row.items.map((item, i) => el('div', { class: `build-result-item${i < row.fixedItemCount ? ' fixed' : ''}` }, image(item), el('div', {}, el('strong', { text: item.name }), !compact ? el('small', { text: i < row.fixedItemCount ? '固定装备' : '补齐装备' }) : null))));
  }
  function showResult(result) {
    results.replaceChildren();
    if (result.status !== 'ok') {
      results.append(el('div', { class: 'build-empty' }, el('h2', { text: result.status === 'insufficient_samples' ? '当前门槛下没有候选' : result.status === 'empty' ? '没有符合条件的三件套' : '条件出装暂不可用' }), el('p', { text: result.reason }), result.selection?.matchedRows ? el('small', { text: `门槛前有 ${result.selection.matchedRows} 种组合；最低样本 ${result.query.minSample}。` }) : null));
      sourceNote(result); return;
    }
    const row = result.best;
    const metricName = METRICS.find(([key]) => key === result.query.sort)?.[1] || '平均名次';
    const directionName = result.query.sortDirection === 'asc' ? '从低到高' : '从高到低';
    const card = el('article', { class: 'build-best-card', 'aria-label': '条件出装第一名' },
      el('div', { class: 'build-best-heading' }, el('div', {}, el('p', { class: 'build-eyebrow', text: '03 / 当前条件排名第一' }), el('h2', { text: `${result.champion.name}的完整三件套` })), el('span', { class: 'build-rank-mark', text: '01' })),
      equipment(row), el('div', { class: 'build-result-stats' }, [['平均名次', row.stats.avgPlacement], ['前四率', row.stats.top4Rate, true], ['登顶率', row.stats.winRate, true], ['样本数', row.stats.sampleSize]].map(([label, value, rate]) => el('div', {}, el('span', { text: label }), el('strong', { text: number(value, rate) })))),
      el('div', { class: 'build-best-footer' }, el('p', { text: `${result.selection.qualifiedRows} 种合格组合 · 最低 ${result.query.minSample} 样本 · ${metricName.split(' · ')[0]}${directionName}` }), btn('问 TFT助手 ↗', () => {
        query.selectedRow = row; onChange(row); onAsk(`按当前条件和样本门槛，${result.champion.name}的最佳完整三件套是什么？请给出组合和统计依据。`);
      }, 'primary small')));
    results.append(card);
    const alternatives = el('div', { class: 'build-alternatives' }, el('h2', { text: '完整组合对比' }), el('p', { text: '每行对应同一英雄携带整套装备的样本，可点击表头调整排序。' }));
    const table = el('table', { class: 'build-table' });
    table.append(el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: '三件套' }), [['avgPlacement', '平均名次'], ['top4Rate', '前四率'], ['winRate', '登顶率'], ['sampleSize', '样本数']].map(([key, label]) => el('th', { scope: 'col', 'aria-sort': result.query.sort === key ? result.query.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none' }, el('button', { type: 'button', text: `${label} ${result.query.sort === key ? result.query.sortDirection === 'asc' ? '↑' : '↓' : '↕'}`, onclick: () => {
      query.sortDirection = query.sort === key ? query.sortDirection === 'asc' ? 'desc' : 'asc' : key === 'avgPlacement' ? 'asc' : 'desc'; query.sort = key; sort.value = key; changed();
    } }))))));
    const body = el('tbody'); table.append(body);
    const pagination = el('div', { class: 'build-pagination' });
    function rows() {
      const pages = Math.ceil(result.data.length / 12); query.page = Math.max(1, Math.min(query.page, pages));
      body.replaceChildren(...result.data.slice((query.page - 1) * 12, query.page * 12).map(candidate => el('tr', {}, el('td', {}, equipment(candidate, true)),
        el('td', { text: number(candidate.stats.avgPlacement) }), el('td', { text: number(candidate.stats.top4Rate, true) }), el('td', { text: number(candidate.stats.winRate, true) }), el('td', { text: number(candidate.stats.sampleSize) }))));
      pagination.replaceChildren(el('span', { text: `第 ${query.page} / ${pages} 页 · 共 ${result.data.length} 种组合` }), el('div', {}, btn('上一页', () => { query.page--; rows(); }, 'ghost small', query.page <= 1), btn('下一页', () => { query.page++; rows(); }, 'ghost small', query.page >= pages)));
    }
    rows(); alternatives.append(el('div', { class: 'build-table-scroll', tabindex: 0, 'aria-label': '三件套对比表，窄屏可横向滚动' }, table), pagination); results.append(alternatives); sourceNote(result);
  }
  function sourceNote(result) {
    const evidence = result.evidence || {};
    results.append(el('div', { class: 'build-source' }, el('p', { text: `${evidence.source || 'OP.GG MCP'} · 统计补丁 ${evidence.sourcePatch || '未知'} · 原采集 ${evidence.fetchedAt ? formatTime(evidence.fetchedAt) : '未知'}` }),
      el('p', { text: '排名范围为当前缓存中已收录的完整三件套。来源未提供的段位、地区和补丁保持未知；组合样本不相加。' })));
  }
  chips(); load();
}
