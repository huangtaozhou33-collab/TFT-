import { renderPatchNotes } from './patch-notes.js';
const TABS = [['patches','版本公告监测','↻'],['assets', '数据资产总览', '▦'], ['schedule', '统计自动更新', '◷'], ['documents', '来源记录与字段', '▤'], ['retrieval', '检索调试器', '⌕'], ['traces', '回答证据链', '⌘'], ['releases', '更新与发布', '↻']];
const STATUS = { cached: '已缓存', live: '已收录', ready: '就绪', ok: '成功', running: '进行中', completed: '完成', complete: '完成', budget_denied: '预算已用尽', valid: '校验通过', passed: '校验通过', invalid: '校验失败', failed: '失败', error: '读取失败', unavailable: '不可用', not_cached: '未收录', not_connected: '未接入', not_configured: '未配置', active: '当前有效', retained_manifest: '保留清单', payload_only: '仅保留内容', current_tool: '当前工具可检索', view_only: '仅供查看', blocked: '禁止检索', missing_baseline: '无比较基线', invalid_selection: '选择无效', incompatible: '版本不兼容' };
Object.assign(STATUS, { active_file_no_publication_manifest: '当前文件 · 无发布清单', active_manifest_pointer: '当前清单指向', invalid_manifest: '清单校验失败', version_mismatch: '版本不匹配', revision_only: '留存修订', verified: '哈希校验通过', schema_valid_checksum_not_recorded: '结构有效 · 无哈希记录', unknown: '未知', degraded: '目录不可用', connected: '已连接' });
Object.assign(STATUS, { configured: '已配置', empty: '尚未导入', indexed: '已构建', not_indexed: '尚未构建', current_tool: '已映射工具', local_files_unavailable: '本机快照不可读' });
Object.assign(STATUS, { quarantined: '待核验', collecting: '积累中', imported: '已入库', reclassified: '已重新核验', conflict: '来源冲突' });
const session = { tab: 'assets', cache: new Map(), pending: new Map(), requestGeneration: 0, filters: {}, documentId: '', traceId: '', traceSearch: '', tracePage: 1, lastInitialTraceId: null, retrievalQuestion: '', retrievalFilters: {}, retrievalResult: null, retrievalError: '', retrieving: false, retrievalSequence: 0, diffFrom: '', diffTo: '', diffResult: null, diffError: '', diffing: false, diffSequence: 0 };
let mountSequence = 0;
let refreshActiveMount = null;
const text = (value, fallback = '未提供') => value == null || value === '' ? fallback : typeof value === 'object' ? JSON.stringify(value) : String(value);
const arr = value => Array.isArray(value) ? value : [];
const count = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
const status = value => STATUS[value] || text(value, '状态未知');
function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (['value', 'checked', 'selected', 'disabled'].includes(key)) element[key] = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}
const button = (label, action, attrs = {}) => node('button', { type: 'button', class: 'dev-button', onclick: action, ...attrs }, label);
const badge = value => node('span', { class: `dev-badge ${['failed', 'invalid', 'error', 'blocked'].includes(value) ? 'bad' : ['cached', 'live', 'ready', 'valid', 'passed', 'active', 'current_tool'].includes(value) ? 'good' : ''}`, text: status(value) });
function date(value) { if (!value) return '未知'; const result = new Date(value); return Number.isNaN(result.getTime()) ? '未知' : result.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
function sourceLinks(sources) {
  return node('div', { class: 'dev-source-links' }, arr(sources).map(source => { const url = safeUrl(source?.url || source?.endpoint); const label = text(source?.name || source?.source || source?.title, '来源'); return url ? node('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: `${label} ↗` }) : node('span', { text: label }); }));
}
function sanitized(value, depth = 0) {
  if (depth > 18) return '[层级省略]';
  if (Array.isArray(value)) return value.map(item => sanitized(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:api[_-]?key|key|secret|token|access[_-]?token|authorization|password|prompt|system[_-]?prompt|messages|environment|env)$/i.test(key)).map(([key, item]) => [key, sanitized(item, depth + 1)]));
  return value;
}
function json(value, label = '查看结构化资料', open = false) {
  if (typeof value === 'string' && /^\s*[\[{]/.test(value)) { try { value = JSON.parse(value); } catch { /* Preserve truncated or plain source content. */ } }
  const cleaned = sanitized(value);
  return node('details', { class: 'dev-json', open }, node('summary', { text: label }), node('pre', { text: typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned, null, 2) ?? '未提供' }));
}
function facts(values) { return node('dl', { class: 'dev-facts' }, values.flatMap(([label, value]) => [node('dt', { text: label }), node('dd', {}, value instanceof Node ? value : text(value))])); }
function panel(title, ...children) { return node('section', { class: 'dev-panel' }, node('div', { class: 'dev-panel-heading' }, node('h2', { text: title })), ...children); }
function summary(values) { return node('div', { class: 'dev-summary' }, values.map(([label, value]) => node('div', {}, node('span', { text: label }), node('strong', { text: count(value) })))); }
function riotChanges(changes) {
  const entries = arr(changes).slice(0, 12);
  if (!entries.length) return null;
  const issues = { invalid_game_time: '比赛时间异常', unsupported_queue: '非普通排位模式', different_season: '赛季不符',
    unmapped_source_version: '来源版本尚未映射', outside_verified_time_window: '超出已核验补丁时间范围', conflicting_patch_windows: '补丁时间范围冲突',
    incomplete_ranked_placements: '排位名次记录不完整', invalid_participant: '玩家终局记录异常', empty_final_board: '终局棋盘为空',
    invalid_unit: '棋子字段异常', unknown_champion: '棋子名称尚未映射', missing_traits: '缺少羁绊记录', invalid_trait: '羁绊字段异常',
    duplicate_trait: '羁绊记录重复', source_payload_conflict: '同场比赛的来源内容发生冲突' };
  const actions = { imported: '新增比赛', reclassified: '重新核验', conflict: '来源冲突', quarantined: '转入待核验', source_payload_conflict: '来源冲突' };
  return node('details', { class: 'dev-json' }, node('summary', { text: `最近入库与核验记录 · ${entries.length} 条` }),
    table(['时间 / 变动', '状态', '模式 / 推定补丁', '玩家终局', '核验说明'], entries.map(entry => {
      const detail = entry.detail || {}, explanations = arr(detail.issues).map(issue => issues[issue] || `待核验项目：${issue}`);
      if (arr(detail.unknownItems).length) explanations.push(`${detail.unknownItems.length} 个装备 ID 待补充映射`);
      return [node('div', {}, node('strong', { text: actions[detail.action] || (String(entry.kind).includes('conflict') ? '来源冲突' : '比赛资料更新') }), node('small', { text: date(entry.createdAt) })),
        badge(detail.status), node('div', {}, node('span', { text: detail.queue === 1100 ? '普通排位' : detail.queue === 1090 ? '匹配模式' : detail.queue == null ? '模式未提供' : `其他模式（${detail.queue}）` }),
          node('small', { text: detail.assignedPatch ? `${detail.assignedPatch} · 推定${detail.season != null ? ` · 赛季 ${detail.season}` : ''}` : '补丁未归属' })),
        count(detail.participants), explanations.length ? explanations.join('；') : detail.status === 'ready' ? '通过入库规则核验' : '核验说明未提供'];
    })));
}
function message(title, description, kind = '') { return node('div', { class: `dev-message ${kind}` }, node('h3', { text: title }), node('p', { text: description })); }
function loading() { return node('div', { class: 'dev-loading', role: 'status' }, node('span', { class: 'spinner small' }), '正在读取本地开发资料…'); }
function metric(value, percentage = false) { if (typeof value !== 'number' || !Number.isFinite(value)) return '—'; return percentage ? `${(value * 100).toFixed(2)}%` : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
function cacheView(evidence) {
  const source = Array.isArray(evidence) ? evidence[0] || {} : evidence || {};
  const age = source.snapshotAgeSeconds ?? source.ageSeconds;
  return node('div', { class: 'dev-cache-evidence' }, node('strong', { text: text(source.source, '来源未知') }), node('small', { text: source.delivery === 'version_cache' ? '本地版本缓存' : `交付 ${text(source.delivery, '未知')}` }), node('small', { text: `来源补丁 ${text(source.sourcePatch || source.gamePatch, '未知')}` }), node('small', { text: `源时间 ${date(source.sourceTime)}` }), node('small', { text: `采集 ${date(source.fetchedAt)}${typeof age === 'number' ? ` · 快照年龄 ${Math.round(age)} 秒` : ''}` }), json(source, '查看缓存依据'));
}
function toolsView(tools) {
  const entries = arr(tools);
  if (!entries.length) return message('没有工具调用', '这条记录没有保留工具执行资料。');
  return node('div', { class: 'dev-tools' }, entries.map(tool => node('details', { class: 'dev-tool' }, node('summary', {}, node('span', { class: 'dev-tool-index', text: tool.index == null ? '·' : String(tool.index) }), node('strong', { text: tool.name || tool.tool || '工具' }), badge(tool.status), node('small', { text: typeof tool.durationMs === 'number' ? `${Math.round(tool.durationMs)} ms` : text(tool.phase, '') })), facts([['执行阶段', tool.phase], ['开始时间', date(tool.startedAt)], ['完成时间', date(tool.completedAt)]]), json(tool.args, '调用参数'), json(tool.selection, '资料选择范围'), json(tool.ranking, '排序依据'), json(tool.result, '返回资料'))));
}
function contextView(value) {
  const entries = Array.isArray(value) ? value : arr(value?.segments);
  if (!entries.length) return value ? json(value, '查看最终资料上下文', true) : message('未保留最终资料', '此记录没有资料上下文片段。');
  return node('div', { class: 'dev-context-segments' }, entries.map(segment => node('details', { class: 'dev-chunk' }, node('summary', {}, node('strong', { text: segment.toolName || (segment.kind === 'page_context' ? '当前页面资料' : text(segment.kind, '资料片段')) }), node('code', { text: text(segment.id) }), segment.truncated ? node('span', { class: 'dev-badge', text: '已截断' }) : null), json(segment.content, '查看实际资料 JSON', true))));
}
function citationsView(citations) {
  const entries = arr(citations);
  if (!entries.length) return node('p', { class: 'dev-note', text: '未保留引用。' });
  return node('div', { class: 'dev-citations' }, entries.map(entry => {
    if (typeof entry === 'string') return node('div', { class: 'dev-citation' }, node('code', { text: entry }));
    const url = safeUrl(entry.url || entry.endpoint || entry.sourceUrl);
    return node('article', { class: 'dev-citation' }, node('div', { class: 'dev-citation-heading' }, node('code', { text: text(entry.id, '无编号') }), url ? node('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: `${entry.title || entry.source || '来源'} ↗` }) : node('strong', { text: text(entry.title || entry.source, '来源') })), cacheView(entry));
  }));
}
function table(headers, rows) {
  return node('div', { class: 'dev-table-scroll', tabindex: 0, 'aria-label': '数据表，窄屏可横向滚动' }, node('table', { class: 'dev-table' }, node('thead', {}, node('tr', {}, headers.map(label => node('th', { scope: 'col', text: label })))), node('tbody', {}, rows.map(cells => node('tr', {}, cells.map(cell => node('td', {}, cell)))))));
}
function metadata(document) {
  return facts([['来源', document.source], ['版本缓存', document.cacheKey], ['赛季', document.set], ['来源补丁', text(document.sourcePatch, '未知')], ['数据状态', badge(document.status)], ['指纹', node('code', { class: 'dev-fingerprint', text: text(document.fingerprint) })]]);
}
function eligible(value) {
  const eligibility = value || {};
  return node('div', { class: 'dev-eligibility' }, badge(eligibility.mode || (eligibility.eligible === true ? 'current_tool' : eligibility.eligible === false ? 'blocked' : null)), node('p', { text: text(eligibility.reason, '未提供可检索性说明') }), arr(eligibility.tools).length ? node('small', { text: `允许工具：${eligibility.tools.join('、')}` }) : null);
}
function getFilters(tab) { return session.filters[tab] ||= { q: '', cacheKey: '', source: '', status: '', set: '', patch: '', page: 1, pageSize: 30 }; }
function queryUrl(path, values = {}) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value != null && value !== '') params.set(key, String(value)); return `${path}${params.size ? `?${params}` : ''}`; }
function select(label, values, selected, onChange) {
  const entries = arr(values).map(value => typeof value === 'object' ? { value: value.value ?? value.id ?? value.cacheKey ?? value.name, label: value.label ?? value.name ?? value.value ?? value.id ?? value.cacheKey } : { value, label: value }).filter(value => value.value != null);
  return node('label', { class: 'dev-filter-field' }, node('span', { text: label }), node('select', { 'aria-label': label, onchange: event => onChange(event.target.value) }, node('option', { value: '', text: `全部${label}` }), entries.map(entry => node('option', { value: entry.value, selected: String(selected) === String(entry.value), text: STATUS[entry.label] || text(entry.label) }))));
}
function filterForm(tab, options, change) {
  const filters = getFilters(tab); const search = node('input', { type: 'search', value: filters.q, placeholder: '搜索名称、实体或指纹…', 'aria-label': '搜索开发资料' });
  const form = node('form', { class: 'dev-filters', onsubmit: event => { event.preventDefault(); filters.q = search.value; filters.page = 1; change(); } }, search, ...[['版本', 'cacheKey', options?.cacheKey || options?.cacheKeys || options?.versions], ['来源', 'source', options?.source || options?.sources], ['状态', 'status', options?.status || options?.statuses], ['赛季', 'set', options?.set || options?.sets], ['补丁', 'patch', options?.patch || options?.patches]].map(([label, key, values]) => select(label, values, filters[key], value => { filters[key] = value; filters.page = 1; change(); })), node('button', { type: 'submit', class: 'dev-button primary', text: '筛选' }), button('重置', () => { session.filters[tab] = { q: '', cacheKey: '', source: '', status: '', set: '', patch: '', page: 1, pageSize: 30 }; change(); }));
  return form;
}
function pagination(info, filters, change) {
  if (!info) return null;
  const page = info.page ?? filters.page; const pageSize = info.pageSize ?? filters.pageSize; const total = info.total;
  const pages = info.totalPages != null || info.pages != null ? Math.max(1, info.totalPages ?? info.pages) : Number.isFinite(total) && pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : null;
  return node('div', { class: 'dev-pagination' }, node('span', { text: `第 ${page}${pages == null ? '' : ` / ${pages}`} 页${total == null ? '' : ` · ${count(total)} 条`} · 每页 ${pageSize}` }), node('div', { class: 'dev-actions' }, button('‹ 上一页', () => { filters.page = Math.max(1, page - 1); change(); }, { disabled: page <= 1 }), button('下一页 ›', () => { filters.page = page + 1; change(); }, { disabled: pages != null ? page >= pages : !info.hasNext })));
}

export function renderDeveloper(main, { api, traceId = null } = {}) {
  const mount = ++mountSequence; const page = node('section', { class: 'dev-page' }); main.append(page);
  if (traceId && traceId !== session.lastInitialTraceId) { session.tab = 'traces'; session.traceId = traceId; }
  session.lastInitialTraceId = traceId || null;
  let paint = 0;
  const alive = () => mount === mountSequence && page.isConnected;
  function refreshLocal() {
    session.requestGeneration += 1; session.cache.clear();
    for (const request of session.pending.values()) request.active = false;
    session.pending.clear(); render();
  }
  function request(path, redraw, force = false) {
    if (force) {
      session.cache.delete(path);
      const old = session.pending.get(path); if (old) old.active = false;
      session.pending.delete(path);
    }
    const saved = session.cache.get(path);
    if ((path.startsWith('/api/developer/trace') || path === '/api/riot/status') && saved && Date.now() - saved.fetchedAt > 30000) session.cache.delete(path);
    if (session.cache.has(path)) return session.cache.get(path);
    if (!session.pending.has(path)) {
      const entry = { generation: session.requestGeneration, active: true, promise: null };
      const current = () => entry.active && entry.generation === session.requestGeneration;
      entry.promise = Promise.resolve().then(() => { if (typeof api !== 'function') throw new Error('未提供开发者 API 连接。'); return api(path); }).then(data => { if (current()) session.cache.set(path, { data, fetchedAt: Date.now() }); }, error => { if (current()) session.cache.set(path, { error: error.message || '读取失败', fetchedAt: Date.now() }); }).finally(() => { if (session.pending.get(path) === entry) session.pending.delete(path); });
      session.pending.set(path, entry);
    }
    const entry = session.pending.get(path);
    entry.promise.then(() => { if (alive() && entry.active && entry.generation === session.requestGeneration) redraw(); }); return null;
  }
  function getResult(path, content, redraw) {
    const result = request(path, redraw);
    if (!result) { content.append(loading()); return null; }
    if (result.error) { content.append(message('开发资料读取未完成', result.error, 'error'), button('重试', () => { request(path, redraw, true); redraw(); })); return null; }
    return result.data;
  }
  function render() {
    if (!alive()) return;
    const currentPaint = ++paint; const redraw = () => { if (alive() && paint === currentPaint) render(); };
    page.replaceChildren(node('header', { class: 'dev-heading' }, node('div', {}, node('p', { class: 'dev-eyebrow', text: 'DEVELOPER CONSOLE' }), node('h1', { text: '开发者模式' }), node('p', { class: 'dev-heading-description', text: '核对数据、检索结果与回答来源。统计更新周期可配置；资料发布与回滚仍为只读预览。' })), node('div', { class: 'dev-header-actions dev-actions' }, button('刷新本地资料', refreshLocal), node('span', { class: 'dev-readonly', text: '本机管理' }))));
    const tabs = node('nav', { class: 'dev-tabs', 'aria-label': '开发者工具' });
    TABS.forEach(([id, label, icon]) => tabs.append(button(`${icon} ${label}`, () => { session.tab = id; render(); }, { class: `dev-tab${session.tab === id ? ' active' : ''}`, 'aria-current': session.tab === id ? 'page' : null })));
    page.append(tabs); const content = node('div', { class: 'dev-content' }); page.append(content);
    if(session.tab==='patches')renderPatchNotes(content,{api,developer:true});
    if (session.tab === 'assets') renderAssets(content, redraw);
    if (session.tab === 'schedule') renderSchedule(content, redraw);
    if (session.tab === 'documents') renderDocuments(content, redraw);
    if (session.tab === 'retrieval') renderRetrieval(content, redraw);
    if (session.tab === 'traces') renderTraces(content, redraw);
    if (session.tab === 'releases') renderReleases(content, redraw);
  }
  function renderSchedule(content,redraw){
    const path='/api/developer/statistics-schedule',data=getResult(path,content,redraw);if(!data)return;
    content.append(message('统计数据默认每天更新',data.note),button('刷新任务状态',()=>{request(path,redraw,true);redraw();}));
    const labels={scheduled:'等待计划',queued:'已排队',running:'采集中',success:'成功',partial:'部分失败',failed:'失败',interrupted:'上次执行中断'};
    for(const job of data.jobs){
      const enabled=node('input',{type:'checkbox',checked:job.enabled,'aria-label':`${job.name}自动更新`});
      const hours=node('input',{type:'number',min:1,max:168,step:1,value:job.intervalHours,'aria-label':`${job.name}更新周期（小时）`});
      const result=node('p',{role:'status',class:'dev-note'});
      const controls=[];
      const submit=async(run=false)=>{
        controls.forEach(b=>b.disabled=true);result.textContent=run?'正在排队…':'正在保存…';
        try{const updated=await api(run?'/api/developer/statistics-run':path,run?{id:job.id}:{id:job.id,enabled:enabled.checked,intervalHours:Number(hours.value),revision:job.revision});
          session.cache.set(path,{data:updated,fetchedAt:Date.now()});redraw();
        }catch(e){result.textContent=e.message;controls.forEach(b=>b.disabled=false);}
      };
      controls.push(button('保存周期',()=>submit()),button('立即采集一次',()=>submit(true),{disabled:['running','queued'].includes(job.status)}));
      content.append(panel(job.name,node('div',{class:'dev-actions'},node('label',{},enabled,'自动更新'),node('label',{},'每 ',hours,' 小时'),...controls),result,
        facts([['状态',labels[job.status]||job.status],['下次执行',job.enabled||job.status==='queued'?date(job.nextRunAt):'已暂停'],['最近开始',date(job.lastStartedAt)],['最近完成',date(job.lastFinishedAt)],['最近全批成功',date(job.lastSuccessAt)]]),
        json(job.progress,'采集进度 / 最近结果'),node('details',{},node('summary',{text:'数据路径与范围'}),node('pre',{text:job.paths.join('\n')}),node('p',{text:job.kind==='reference'?'来源自定段位和窗口，不与 MetaTFT 样本合并；独立 MySQL 参考快照。':'当前赛季、当前补丁、普通排位、近 3 天；全部 12 种段位范围分别保存。'}))));
    }
    content.append(panel('最近执行记录',table(['任务','开始','结束','结果'],data.runs.map(r=>[data.jobs.find(j=>j.id===r.job_id)?.name||r.job_id,date(Number(r.started_at)),date(r.finished_at==null?null:Number(r.finished_at)),labels[r.status]||r.status]))));
  }
  function renderAssets(content, redraw) {
    const filters = getFilters('assets'); const path = queryUrl('/api/developer/overview', filters); const data = getResult(path, content, redraw); if (!data) return;
    const counts = data.counts || {}; const context = data.current?.context || {};
    if (data.status === 'degraded' || !data.current) content.append(message('当前版本目录未就绪', '目录或来源包未通过读取与校验；下方仅展示实际扫描结果，不能将空计数视为完整资产清单。', 'error'));
    content.append(node('div', { class: 'dev-current-context' }, node('span', { text: `当前赛季 ${text(context.set, '未知')}` }), node('span', { text: `资源版本 ${text(context.assetVersion, '未知')}` }), node('span', { text: `规则版本 ${text(context.rulesVersion, '未知')}` }), node('code', { text: text(data.current?.cacheKey, '缓存版本未知') })));
    content.append(node('div', { class: 'dev-entity-counts' }, ...Object.entries({ champions: '英雄与形态', items: '装备', traits: '羁绊', augments: '强化符文', mechanics: '赛季玩法' }).filter(([key]) => counts.entities?.[key] != null).map(([key, label]) => node('span', { text: `${label} ${count(counts.entities[key])}` }))));
    const storage = data.storage || {}, runtime = data.storageRuntime;
    const actual = runtime || storage, backend = runtime?.backend || storage.engine;
    const knowledgeCounts = runtime?.knowledgeCounts || runtime?.activeRelease?.counts;
    if (backend === 'mysql' && knowledgeCounts) {
      content.append(panel('当前 RAG 知识库', summary([['知识文档', knowledgeCounts.documents], [runtime.knowledgeCounts ? '当前可检索文档' : '发布时符合检索条件的文档', knowledgeCounts.eligibleDocuments], ['知识片段', knowledgeCounts.chunks], ['Milvus 已索引片段', runtime.milvus?.indexedChunks]]),
        node('p', { class: 'dev-note', text: runtime.knowledgeCounts ? `文档与片段是当前数据库发布的实际计数；当前补丁资料及通用术语共 ${count(knowledgeCounts.eligibleChunks)} 个片段符合检索条件。通用术语不代表该补丁的数值规则。Milvus 数量来自索引状态，索引记录数不等于本次回答引用数。` : `文档和片段数量来自当前数据库发布记录；其中 ${count(knowledgeCounts.eligibleChunks)} 个片段在发布时通过核验。Milvus 数量来自索引状态。机制资料按当前补丁筛选，通用术语单独标明，向量数量不等于本次回答引用数量。` })));
    }
    content.append(panel('存储与索引', node('div', { class: 'dev-storage-grid' }, node('div', {}, node('strong', { text: backend === 'mysql' ? 'MySQL' : backend === 'local_json' ? '本地 JSON' : text(backend, '未知') }), node('small', { text: '当前业务读取方式' })), ...['mysql', 'milvus', 'redis'].map(key => node('div', {}, node('strong', { text: { mysql: 'MySQL', milvus: 'Milvus', redis: 'Redis' }[key] }), badge(actual[key]?.status))), node('div', {}, node('strong', { text: 'Embedding' }), badge(actual.embedding?.status))),
      runtime ? facts([['当前数据库发布', runtime.activeRelease?.id || '尚无发布'], ['当前查询补丁', runtime.activeRelease?.currentPatch || '未提供'], ['初始资料补丁', runtime.activeRelease?.seedPatch || '未提供'], ['向量索引', badge(runtime.milvus?.indexed ? 'indexed' : 'not_indexed')], ['已索引片段', runtime.milvus?.indexedChunks ?? 0]]) : null,
      runtime?.statistics ? facts([['发布包历史统计快照（不含 MetaTFT）', runtime.statistics.total], ['来源声明版本', runtime.statistics.sourceDeclared], ['当前补丁推定归属', runtime.statistics.assignedCurrent], ['当前查询不可用', runtime.statistics.unavailable]]) : null,
      runtime?.statistics?.assignedCurrent ? node('p', { class: 'dev-note', text: '推定归属依据采集日期和补丁日历，不等于来源声明；原始版本字段保持原样，归属依据单独记录。' }) : null,
      node('p', { class: 'dev-note', text: '下方来源包清单扫描随应用附带的 JSON 资产；上方连接与索引状态来自运行中的存储服务。' })));
    if (backend === 'mysql') {
      const meta = runtime?.metatft;
      content.append(panel('MetaTFT 统计数据库', meta?.status === 'ready' ? node('div', {},
        summary([['目录统计快照', meta.datasets.snapshots], ['目录统计记录', meta.datasets.rows], ['组合查询快照', meta.queries.snapshots], ['组合查询记录', meta.queries.rows]]),
        facts([['目录查询键', meta.datasets.distinctKeys], ['未过期目录快照', meta.datasets.unexpiredSnapshots], ['组合查询键', meta.queries.distinctKeys], ['未过期组合快照', meta.queries.unexpiredSnapshots], ['统计时间', date(meta.countedAt)]]),
        node('p', { class: 'dev-note', text: meta.note }),
        node('p', { class: 'dev-note', text: '阵容首页、大数据、筛选器和自然语言统计查询共用 MetaTFT 服务。目录快照保鲜 6 小时，组合查询保鲜 10 分钟；过期后保留审计记录，不会自动删除或混入当前结果。' }))
        : message('MetaTFT 入库计数暂不可读', meta?.reason || '刷新页面以读取当前服务状态；缺失不代表零记录。', 'error')));
    }
    const riotRequest = request('/api/riot/status', redraw), riot = riotRequest?.data;
    content.append(panel('Riot 比赛数据库', riot ? node('div', {},
      facts([['状态', badge(riot.status)], ['当前补丁', riot.currentPatch], ['赛季', riot.season], ['最近采集', date(riot.latestFetchedAt)]]),
      summary([['已入库比赛', riot.matches?.total], ['当前可查询比赛', riot.matches?.readyCurrent], ['当前玩家终局', riot.participantsCurrent], ['待核验比赛', riot.matches?.quarantined]]),
      node('p', { class: 'dev-note', text: `其他补丁比赛 ${count(riot.matches?.otherPatch)} 场。比赛数、玩家终局数与 RAG 文档数量分别统计。未知或无法归属当前版本的比赛不会进入当前筛选结果。` }),
      riot.lastJob ? facts([['最近采集任务', badge(riot.lastJob.status)], ['任务状态更新时间', date(riot.lastJob.updatedAt)], ['待处理比赛', count(riot.lastJob.pendingCount)]]) : null,
      riot.worker ? facts([['定时采集', badge(riot.worker.status)], ['最近运行', date(riot.worker.lastAttemptAt)], ['下次运行', date(riot.worker.nextRunAt || riot.worker.nextAttemptAt)]]) : null,
      riotChanges(riot.recentChanges),
      arr(riot.unknownItems).length ? node('details', { class: 'dev-json' }, node('summary', { text: `待补充装备映射 · ${riot.unknownItems.length} 个 ID` }), table(['来源装备 ID', '出现次数'], riot.unknownItems.map(item => [node('code', { text: item.id }), count(item.count)]))) : null
    ) : riotRequest?.error ? message('比赛状态暂不可读', riotRequest.error, 'error') : loading()));
    content.append(panel('来源资产归档 · 含历史修订', summary([['来源包', counts.packages], ['来源记录（含历史）', counts.documents], ['当前工具映射记录', counts.retrievalEligibleDocuments], ['来源校验失败', counts.validationFailures]]),
      node('p', { class: 'dev-note', text: data.sourceAccounting?.note || '这里统计 JSON 来源字段投影，包含历史修订，不是 RAG 文档和向量数量。' }),
      arr(data.sourceAccounting?.groups).length ? table(['记录用途 / 留存原因', '数量'], data.sourceAccounting.groups.map(group => [group.label, count(group.count)])) : null,
      counts.localFilesUnavailablePackages ? node('p', { class: 'dev-note', text: `${count(counts.localFilesUnavailablePackages)} 个来源包的本机快照未提供或不可读。Docker 镜像未打包原始 OP.GG 快照；这与 MySQL 中已导入的资料是两条独立检查。` }) : null));
    const assets = arr(data.assets);
    content.append(panel('来源包与快照', filterForm('assets', data.filterOptions, redraw), assets.length ? table(['数据资产', '来源 / 补丁', '版本 / 赛季', '状态', '校验 / 检索', '指纹'], assets.map(asset => [node('div', {}, node('strong', { text: asset.name || asset.id }), node('small', { text: text(asset.family) }), json(asset.counts, '查看记录数量')), node('div', {}, node('span', { text: text(asset.source) }), node('small', { text: `补丁 ${text(asset.sourcePatch, '未知')}` })), node('div', {}, node('code', { text: text(asset.cacheKey) }), node('small', { text: `赛季 ${text(asset.set, '未知')}${asset.current ? ' · 当前' : ''}` })), badge(asset.status), node('div', {}, badge(asset.validation?.status), eligible(asset.retrievalEligibility)), node('code', { class: 'dev-fingerprint', text: text(asset.fingerprint) })])) : message('没有匹配的数据资产', '调整版本、来源或搜索条件。'), pagination(data.pagination, filters, redraw)));
  }
  function renderDocuments(content, redraw) {
    const filters = getFilters('documents'); const path = queryUrl('/api/developer/documents', filters); const data = getResult(path, content, redraw); if (!data) return;
    const documents = arr(data.documents);
    if (data.status === 'degraded') content.append(message('当前目录不可用', '文档清单可能不完整；请先核对数据资产页的包校验状态。', 'error'));
    content.append(panel('来源记录目录', node('p', { class: 'dev-note', text: data.note }), filterForm('documents', data.filterOptions, redraw), documents.length ? table(['来源记录', '来源 / 补丁', '目录版本', '展示字段', '工具映射'], documents.map(document => [button(document.title || document.id, () => { session.documentId = document.id; redraw(); }, { class: `dev-text-button${session.documentId === document.id ? ' active' : ''}` }), node('div', {}, node('span', { text: text(document.source) }), node('small', { text: `补丁 ${text(document.sourcePatch, '未知')}` })), node('code', { text: text(document.cacheKey) }), node('span', { text: count(document.chunkCount) }), eligible(document.retrievalEligibility)])) : message('没有匹配的来源记录', '搜索真实来源资料；未收录资料不会生成占位内容。'), pagination(data.pagination, filters, redraw)));
    if (!session.documentId) return content.append(message('选择一份文档', '查看它的原文、结构化切片、版本与检索权限。'));
    const detailPath = queryUrl('/api/developer/document', { id: session.documentId }); const detail = getResult(detailPath, content, redraw); if (!detail) return;
    const document = detail.document || (detail.id ? detail : null);
    if (!document) return content.append(message('该文档未收录', detail.reason || '请在目录中选择仍存在的文档。'));
    if (document.contentNote) content.append(node('p', { class: 'dev-note', text: document.contentNote }));
    content.append(panel(document.title || '文档详情', metadata(document), eligible(document.retrievalEligibility), node('div', { class: 'dev-document-status' }, node('span', { text: `切片方式：${document.chunking?.strategy === 'structured_tool_fields' ? '结构化工具字段' : text(document.chunking?.strategy)}` }), node('span', { text: '来源字段投影；实际向量索引与 Embedding 状态见资产总览' })), panel('来源字段文本', typeof document.originalText === 'string' && document.originalText ? node('pre', { class: 'dev-document-content', text: document.originalText }) : node('p', { class: 'dev-note', text: '来源未提供独立原文；可查看下方实际结构化字段。' })), panel('结构化来源字段', typeof document.content === 'string' ? node('pre', { class: 'dev-document-content', text: document.content }) : json(document.content, '展开结构化字段', true)), panel(`切片 · ${count(arr(document.chunks).length)}`, arr(document.chunks).length ? node('div', { class: 'dev-chunks' }, arr(document.chunks).map(chunk => node('details', { class: 'dev-chunk' }, node('summary', {}, node('strong', { text: text(chunk.field, '字段') }), node('code', { text: text(chunk.id) })), typeof chunk.content === 'string' ? node('pre', { text: chunk.content }) : json(chunk.content, '查看切片内容', true)))) : message('未提供切片', '该文档仍可按来源字段查看。')), sourceLinks(document.sources)));
  }
  function renderRetrieval(content, redraw) {
    const overview = getResult('/api/developer/overview', content, redraw); if (!overview) return;
    const options = overview.filterOptions || {}; const context = overview.current?.context || {};
    content.append(message('只读检索调试 · 0 聊天模型调用', '执行实际预取工具，核对召回资料与进入回答上下文的内容。此操作不生成回答；混合检索的未缓存问题可能调用 Embedding 服务。'));
    const question = node('textarea', { value: session.retrievalQuestion, rows: 4, maxlength: 4000, placeholder: '输入问题，例如：大树应该带哪些装备？', 'aria-label': '待调试的检索问题', oninput: event => { session.retrievalQuestion = event.target.value; submit.disabled = session.retrieving || !event.target.value.trim(); } });
    const submit = button(session.retrieving ? '正在检索…' : '运行只读检索', () => runRetrieval(overview, redraw), { class: 'dev-button primary', disabled: session.retrieving || !session.retrievalQuestion.trim() });
    content.append(panel('问题与版本范围', question, node('div', { class: 'dev-retrieval-controls' }, ...[['版本', 'cacheKey', options.cacheKey || options.versions], ['赛季', 'set', options.set || options.sets]].map(([label, key, values]) => select(label, values, session.retrievalFilters[key], value => { session.retrievalFilters[key] = value; })), submit), node('p', { class: 'dev-note', text: `检索仅接当前版本：赛季 ${text(context.set, '未知')} · 资源 ${text(context.assetVersion, '未知')}；选择历史版本将返回范围不匹配。来源补丁由各工具分别提供，不作为全库过滤。` })));
    if (session.retrievalError) content.append(message('检索调试未完成', session.retrievalError, 'error'));
    if (session.retrieving) content.append(loading());
    const result = session.retrievalResult; if (!result) return;
    content.append(panel('本次检索范围', facts([['调试记录', result.traceId], ['问题', result.question], ['模式', result.mode === 'prefetch_preview' ? '预取资料预览' : result.mode]]), json(result.versionFilters, '查看实际版本过滤', true), button('打开本次检索证据链', () => { session.traceId = result.traceId; session.tab = 'traces'; render(); }, { disabled: !result.traceId })));
    const recalled = arr(result.recall?.rows);
    content.append(panel('召回资料与排序', summary([['执行工具', arr(result.tools).length], ['保留统计行', recalled.length], ['工具结果', arr(result.recall?.fragments).length], ['知识片段', result.recall?.knowledgeEvidenceCount ?? '未报告'], ['聊天模型调用', 0]]), recalled.length ? table(['记录', '样本', '平均名次', '来源排序'], recalled.slice(0, 30).map(row => [row.name || row.id || '记录', count(row.stats?.sampleSize), metric(row.stats?.avgPlacement), count(row.rank)])) : null, recalled.length > 30 ? node('p', { class: 'dev-note', text: '表格展示前 30 条；全部召回资料可在下方展开。' }) : null, arr(result.tools).length ? toolsView(result.tools) : null, json(result.recall, '查看全部召回资料'), json(result.ranking, '查看实际排序依据', true)));
    content.append(panel('重排', message('重排模型未接入', result.reranking?.note || '未接入独立重排模型；知识检索状态见各工具的 retrieval。'), json(result.reranking, '查看重排状态')));
    content.append(panel('候选资料上下文 · 未提交模型', contextView(result.modelContext), json(result.cache, '查看来源缓存与采集时间')));
  }
  function renderTraces(content, redraw) {
    const listPath = queryUrl('/api/developer/traces', { limit: 20, offset: (session.tracePage - 1) * 20 });
    const data = getResult(listPath, content, redraw); if (!data) return;
    const traces = arr(data.traces); const retention = data.retention || {};
    content.append(panel('真实问答记录', node('p', { class: 'dev-note', text: `保存方式：${retention.storage === 'process_memory' ? '当前服务进程内存' : text(retention.storage)}${retention.maxTraces != null ? ` · 最多 ${count(retention.maxTraces)} 条` : ''}${retention.ttlMs != null ? ` · 保留约 ${Math.round(retention.ttlMs / 60000)} 分钟` : ''}。服务重启或记录过期后可能无法查看。` }), traces.length ? table(['问题 / 时间', '模式', '状态', '工具', '统计行', '正文引用'], traces.map(trace => [node('div', {}, button(trace.question || '未保存问题文本', () => { session.traceId = trace.id; session.traceRowsPage = 1; redraw(); }, { class: `dev-text-button${session.traceId === trace.id ? ' active' : ''}` }), node('small', { text: date(trace.createdAt) })), trace.mode === 'prefetch_preview' ? '检索预览' : text(trace.mode, '问答'), badge(trace.status), count(trace.toolCount), count(trace.rowCount), count(trace.citedCount)])) : message('暂无保留的问答记录', '发送一次真实问答或运行只读检索后，再查看证据链。'), node('div', { class: 'dev-pagination' }, node('span', { text: `第 ${session.tracePage} 页 · 共 ${count(data.total)} 条记录` }), node('div', { class: 'dev-actions dev-trace-pages' }, button('‹ 上一页', () => { session.tracePage = Math.max(1, session.tracePage - 1); redraw(); }, { disabled: session.tracePage <= 1 }), button('下一页 ›', () => { session.tracePage += 1; redraw(); }, { disabled: (data.offset || 0) + (data.limit || 20) >= (data.total || 0) }), button('刷新记录', () => { request(listPath, redraw, true); redraw(); })))));
    if (!session.traceId) return content.append(message('选择一次回答', '依次核对使用的工具、统计样本、缓存时间和正文引用。'));
    const detail = getResult(queryUrl('/api/developer/trace', { id: session.traceId }), content, redraw); if (!detail) return;
    const trace = detail.trace || detail;
    content.append(panel('这次回答', facts([['记录 ID', trace.id], ['问题', trace.question], ['创建时间', date(trace.createdAt)], ['到期时间', date(trace.expiresAt)], ['状态', badge(trace.status)]]), trace.failure ? message('该次问答未完成', trace.failure.message || '原始异常已省略。', 'error') : null, trace.storageTruncated ? message('记录已截断', '内容超过保留上限，部分返回资料或片段已省略。') : null, trace.reply ? node('details', { class: 'dev-json' }, node('summary', { text: '查看保留的回答正文' }), node('pre', { text: trace.reply })) : null, toolsView(trace.tools)));
    const rows = arr(trace.statRows); const pages = Math.max(1, Math.ceil(rows.length / 30)); session.traceRowsPage = Math.min(pages, Math.max(1, session.traceRowsPage || 1));
    content.append(panel(`统计依据 · ${count(rows.length)} 行`, rows.length ? table(['记录', '种类 / 工具', '样本数', '均次', '前四 / 第一', '来源 / 缓存'], rows.slice((session.traceRowsPage - 1) * 30, session.traceRowsPage * 30).map(row => [node('div', {}, node('strong', { text: row.name || row.id || '统计行' }), row.citation ? node('small', { text: typeof row.citation === 'string' ? row.citation : text(row.citation.id) }) : null), node('div', {}, node('span', { text: text(row.kind) }), node('small', { text: `工具 ${row.toolIndex ?? '未知'}` })), count(row.stats?.sampleSize), metric(row.stats?.avgPlacement), node('div', {}, node('span', { text: metric(row.stats?.top4Rate, true) }), node('small', { text: metric(row.stats?.winRate, true) })), cacheView(row.sourceEvidence)])) : message('没有统计行', '此次回答可能使用规则、资料说明或未收录统计。'), rows.length > 30 ? node('div', { class: 'dev-pagination' }, node('span', { text: `第 ${session.traceRowsPage} / ${pages} 页 · 每页 30 行` }), node('div', { class: 'dev-actions' }, button('‹ 上一页', () => { session.traceRowsPage -= 1; redraw(); }, { disabled: session.traceRowsPage <= 1 }), button('下一页 ›', () => { session.traceRowsPage += 1; redraw(); }, { disabled: session.traceRowsPage >= pages }))) : null));
    const citations = trace.citations || {};
    content.append(panel('最终引用', node('h3', { class: 'dev-subtitle', text: '正文实际引用' }), citationsView(citations.cited), arr(citations.unresolvedIds).length ? message('未解析的引用', citations.unresolvedIds.join('、'), 'error') : null, node('details', { class: 'dev-json' }, node('summary', { text: `查看全部 ${count(arr(citations.retrieved).length)} 条检索证据` }), citationsView(citations.retrieved))));
    const reads = arr(trace.cache?.reads);
    content.append(panel('实际缓存读取', node('p', { class: 'dev-note', text: `Redis：${status(trace.cache?.redis?.status)}。快照年龄对应原始采集时间；未知时间保持未知，本次读取不会刷新来源数据。` }), reads.length ? table(['工具', '交付', '来源补丁', '源时间', '采集时间', '快照年龄'], reads.map(read => [read.name || `工具 ${read.toolIndex ?? ''}`, read.delivery === 'version_cache' ? '本地版本缓存' : text(read.delivery, '未知'), text(read.sourcePatch, '未知'), date(read.sourceTime), date(read.fetchedAt), typeof read.ageSeconds === 'number' ? `${count(read.ageSeconds)} 秒` : '未知'])) : message('没有保留缓存读取记录', '不会推测缓存命中或采集时间。')));
    content.append(panel(trace.mode === 'prefetch_preview' ? '候选资料上下文 · 未提交模型' : '进入模型的资料', contextView(trace.modelContext), json(trace.modelInputs, '查看资料提交批次'), node('p', { class: 'dev-note', text: '这里仅展示资料片段与提交批次，不展示系统提示词、聊天历史或密钥。' })));
  }
  function renderReleases(content, redraw) {
    const data = getResult('/api/developer/releases', content, redraw); if (!data) return;
    const releases = arr(data.releases); const baseline = data.baseline || {};
    content.append(panel('版本与发布记录', releases.length ? table(['来源包', '版本 / 赛季', '补丁', '保留状态', '时间', '校验'], releases.map(release => [node('div', {}, node('strong', { text: release.name || release.packageId || release.id }), node('small', { text: text(release.family) })), node('div', {}, node('code', { text: text(release.cacheKey) }), node('small', { text: `赛季 ${text(release.set, '未知')}${release.current ? ' · 当前' : ''}` })), text(release.sourcePatch, '未知'), badge(release.publicationState), date(release.publishedAt), badge(release.validation?.status)])) : message('暂无发布记录', '页面只显示实际保留的来源包与校验记录。')));
    const initial = releases.find(release => release.current) || releases[0];
    if (!session.diffTo && initial) session.diffTo = initial.id;
    const choices = releases.map(release => ({ value: release.id, label: `${release.name || release.packageId || release.id} · ${status(release.status)} · ${String(release.fingerprint || release.id).slice(0, 12)} · ${release.cacheKey || '版本未知'}` }));
    const preview = button(session.diffing ? '比较中…' : '预览差异', () => runDiff(redraw), { disabled: session.diffing || !session.diffFrom || !session.diffTo, class: 'dev-button primary' });
    content.append(panel('差异与回滚预览', baseline.available === false ? message('没有可比较的历史基线', baseline.reason || '旧清单不等于完整历史内容。缺少基线时无法计算增删改。') : null, node('div', { class: 'dev-diff-controls' }, select('基线', choices, session.diffFrom, value => { session.diffFrom = value; session.diffResult = null; redraw(); }), select('目标', choices, session.diffTo, value => { session.diffTo = value; session.diffResult = null; redraw(); }), preview), session.diffError ? message('差异预览未完成', session.diffError, 'error') : null, session.diffResult ? diffView(session.diffResult) : null, node('p', { class: 'dev-note', text: '差异与回滚均为只读预览，不修改当前资料。执行发布、重建索引或回滚需要独立权限。' }), node('div', { class: 'dev-actions' }, ...['发布版本', '重建索引', '执行回滚'].map(label => node('span', { title: '独立执行权限未配置' }, button(label, null, { disabled: true }))))));
    const events = arr(data.events);
    content.append(panel('采集与校验事件', events.length ? node('div', { class: 'dev-events' }, events.map(event => node('article', {}, node('div', { class: 'dev-event-heading' }, node('strong', { text: event.name || event.type || event.id || '事件' }), badge(event.status), node('time', { text: event.occurredAt || event.timestamp || event.fetchedAt || event.createdAt ? date(event.occurredAt || event.timestamp || event.fetchedAt || event.createdAt) : `观测 ${date(event.observedAt)}` })), event.reason || event.message ? node('p', { text: event.reason || event.message }) : null, event.note ? node('p', { text: event.note }) : null, json(event, '查看事件详情')))) : message('暂无事件记录', '未保留的采集日志不会推测补齐。')));
  }
  async function runDiff(redraw) {
    if (session.diffing || !session.diffFrom || !session.diffTo) return;
    const sequence = ++session.diffSequence; session.diffing = true; session.diffError = ''; redraw();
    try { const result = await api('/api/developer/diff', { from: session.diffFrom, to: session.diffTo }); if (sequence === session.diffSequence) session.diffResult = result; }
    catch (error) { if (sequence === session.diffSequence) session.diffError = error.message; }
    finally { if (sequence === session.diffSequence) { session.diffing = false; refreshActiveMount?.(); } }
  }
  async function runRetrieval(overview, redraw) {
    if (session.retrieving || !session.retrievalQuestion.trim()) return;
    const sequence = ++session.retrievalSequence; const current = overview.current || {};
    const context = { ...(current.context || {}), cacheKey: current.cacheKey };
    for (const [key, value] of Object.entries(session.retrievalFilters)) if (value !== '') context[key] = key === 'set' ? Number(value) : value;
    session.retrieving = true; session.retrievalError = ''; session.retrievalResult = null; redraw();
    try { const result = await api('/api/developer/retrieval', { question: session.retrievalQuestion.trim(), context }, 60000); if (sequence === session.retrievalSequence) session.retrievalResult = result; }
    catch (error) { if (sequence === session.retrievalSequence) session.retrievalError = error.message || '检索调试失败'; }
    finally { if (sequence === session.retrievalSequence) { session.retrieving = false; refreshActiveMount?.(); } }
  }
  function diffView(result) {
    if (result.status !== 'ready') return message(status(result.status), result.reason || '该选择没有可比较的完整资料。');
    const changes = result.changes || {};
    return node('div', { class: 'dev-diff-result' }, summary([['新增', changes.added], ['移除', changes.removed], ['变更', changes.changed], ['未变', changes.unchanged]]), json({ from: result.from, to: result.to, changes }, '展开差异资料'), node('details', { class: 'dev-json' }, node('summary', { text: '只读回滚预览' }), node('p', { class: 'dev-note', text: '回到基线需要恢复该版本完整资料；此处只展示目标与基线，不执行回滚。' }), json({ restore: result.from, replace: result.to, previewOnly: result.previewOnly }, '查看回滚目标', true)));
  }
  refreshActiveMount = () => { if (alive()) render(); };
  render();
}
