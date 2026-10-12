import { renderTftBoard, renderLineupSummary } from './tft-board.js';
import { validateLineup, createLineupFromDeck, lineupContextKey, computeLineupTraits } from './lineup-model.js';
import { roster } from './comps.js';
import { createTeamNotesStore, moveLineupUnit, TEAM_NOTE_LIMITS, defaultNoteVersion, noteVersionLabel } from './team-notes.js';

const clone = value => JSON.parse(JSON.stringify(value));
const uid = () => globalThis.crypto?.randomUUID?.() || `unit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
function element(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (['value', 'disabled', 'readOnly', 'checked'].includes(key)) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const button = (label, click, { primary = false, disabled = false, danger = false } = {}) => element('button', {
  type: 'button', class: `tp-button${primary ? ' tp-primary' : ''}${danger ? ' tp-danger' : ''}`, onclick: click, disabled,
}, label);
function safeImage(entity) {
  if (!entity?.icon) return null;
  try {
    const url = new URL(entity.icon, location.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return element('img', { src: url.href, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: event => event.currentTarget.remove() });
  } catch { return null; }
}
function versionLabel(context) { return `S${context?.set ?? '?'} · 资源 ${context?.assetVersion ?? '?'} · 规则 ${context?.rulesVersion ?? '?'}`; }
function fileDownload(content, name) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const anchor = element('a', { href: url, download: name }); document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Personal research notes only; no inventory, automatic item allocation, or source-stat claims. */
export function renderTeamPlanner(main, { catalog, api, toast = () => {}, initialDeck, initialLineup, rulesPatch } = {}) {
  const host = element('section', { class: 'team-planner', 'aria-label': '个人阵容笔记' });
  main.replaceChildren(host);
  // The mechanism directory is a separate version cache, not part of the static catalog response.
  const noteCatalog = { ...catalog, charms: Array.isArray(catalog?.charms) ? catalog.charms : undefined };
  let store;
  try { store = createTeamNotesStore({ catalog: noteCatalog }); } catch (error) { host.append(element('p', { class: 'tp-error', text: error.message })); return; }
  const champions = new Map((catalog.champions || []).map(entity => [entity.id, entity]));
  const items = new Map((catalog.items || []).map(entity => [entity.id, entity]));
  const augments = new Map((catalog.augments || []).map(entity => [entity.id, entity]));
  let wisps = new Map((noteCatalog.charms || []).map(entity => [entity.id, entity]));
  let wispsReady = Array.isArray(noteCatalog.charms), wispsLoading = false, wispsError = '';
  const watchSearch = { augmentIds: '', wispIds: '' };
  let draft = blank(), selectedId = null, currentId = null, readOnly = false, dirty = false;
  let code = '', codeResult = null, codeBusy = false, codeError = '', importBusy = false;
  let championSearch = '', itemSearch = '', storageError = '', dirtyBadge;
  let unsavedDialog = null, pendingPaint = false;
  let screen = 'home', noteSearch = '', notePatchFilter = '';
  const mounted = () => main.contains(host);
  function blank() { return { schemaVersion: 2, title: '', strategy: '', notes: '', context: clone(catalog.context), versionTag: defaultNoteVersion(catalog.context, rulesPatch), units: [],
    watchlist: { augmentIds: [], wispIds: [] }, origin: 'personal_note', modified: true, source: null, sourceSnapshot: null }; }
  function notify(message, error = false) { toast(message, error); }
  async function loadWispDirectory() {
    if (wispsReady || wispsLoading) return;
    wispsLoading = true; wispsError = ''; paint();
    try {
      const result = await api('/api/mechanics');
      if (!mounted()) return;
      if (lineupContextKey(result?.context) !== lineupContextKey(catalog.context)) throw new Error('法杖目录与当前笔记版本不匹配。');
      if (result.status !== 'cached' || !Array.isArray(result.entries)) throw new Error(result.reason || '当前版本法杖目录尚未就绪。');
      if (result.entries.some(entry => typeof entry?.id !== 'string' || typeof entry?.name !== 'string') || new Set(result.entries.map(entry => entry.id)).size !== result.entries.length) throw new Error('法杖目录实体格式无效。');
      noteCatalog.charms = result.entries; wisps = new Map(result.entries.map(entry => [entry.id, entry])); wispsReady = true;
    } catch (error) { if (mounted()) wispsError = error.message || '法杖目录读取失败。'; }
    finally { wispsLoading = false; if (mounted()) paint(); }
  }
  function watchIds(key) { return Array.isArray(draft.watchlist?.[key]) ? draft.watchlist[key] : []; }
  function changeWatch(key, id, add) {
    if (readOnly) return;
    const current = watchIds(key); const directory = key === 'augmentIds' ? augments : wisps;
    if (add && !directory.has(id)) { notify('该条目不属于已核验的当前版本目录。', true); return; }
    if (add && current.includes(id)) return;
    if (add && current.length >= TEAM_NOTE_LIMITS.watchlist) { notify(`每类最多留意 ${TEAM_NOTE_LIMITS.watchlist} 项。`, true); return; }
    draft = { ...draft, watchlist: { augmentIds: [...watchIds('augmentIds')], wispIds: [...watchIds('wispIds')],
      [key]: add ? [...current, id] : current.filter(value => value !== id) } };
    dirty = true; paint();
  }
  function protectUnsaved() {
    if (!mounted()) return Promise.resolve(false);
    if (!dirty) return Promise.resolve(true);
    // A second operation cannot share a decision intended for the first one.
    if (unsavedDialog) return Promise.resolve(false);
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const backgrounds = [...host.children].map(node => ({ node, inert: node.inert }));
      for (const { node } of backgrounds) node.inert = true;
      const titleId = `tp-unsaved-${uid()}`;
      let observer;
      const finish = accepted => {
        if (!unsavedDialog) return;
        observer?.disconnect(); overlay.remove(); unsavedDialog = null;
        for (const { node, inert } of backgrounds) node.inert = inert;
        if (mounted() && pendingPaint) { pendingPaint = false; paint(); }
        if (mounted() && previousFocus?.isConnected) previousFocus.focus();
        resolve(Boolean(accepted && mounted()));
      };
      const cancel = button('保留编辑', () => finish(false));
      const proceed = button('继续切换', () => finish(true), { primary: true });
      const dialog = element('div', { class: 'tp-unsaved-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
        onkeydown: event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
          if (event.key === 'Tab') {
            event.preventDefault(); (document.activeElement === cancel ? proceed : cancel).focus();
          }
        },
      }, element('h2', { id: titleId, text: '有未保存的修改' }),
      element('p', { text: '继续切换会放弃本次未保存的修改。已保存的笔记仍会保留。' }),
      element('div', { class: 'tp-actions' }, cancel, proceed));
      const overlay = element('div', { class: 'tp-dialog-backdrop' }, dialog);
      unsavedDialog = overlay; host.append(overlay);
      observer = new MutationObserver(() => { if (!mounted()) finish(false); });
      observer.observe(main, { childList: true });
      cancel.focus();
    });
  }
  function changeState(next, { announce = false } = {}) {
    if (readOnly) return;
    const check = validateLineup(next, catalog, { allowUnplaced: true });
    if (!check.valid) { notify(check.errors?.[0]?.message || '阵容校验未通过。', true); return false; }
    draft = { ...next, units: clone(check.lineup.units) }; dirty = true;
    draft.modified = !draft.sourceSnapshot || JSON.stringify(draft.units) !== JSON.stringify(draft.sourceSnapshot.units);
    if (announce) notify('已更新个人棋盘，记得保存笔记。');
    paint(); return true;
  }
  function adopt(input, { source = false, notice = '' } = {}) {
    if (lineupContextKey(input?.context) !== lineupContextKey(catalog.context)) throw new Error('阵容版本与当前资料库不匹配，不能带入。');
    const check = validateLineup(input, catalog, { allowUnplaced: true });
    if (!check.valid) throw new Error(check.errors?.[0]?.message || '阵容校验未通过。');
    const base = { ...blank(), ...clone(input), units: clone(check.lineup.units), id: undefined, strategy: input.strategy || '', notes: input.notes || '', origin: 'personal_note' };
    if (!source) base.versionTag = clone(input.versionTag ?? null) ?? undefined;
    if (source && base.source && base.units.some(unit => /editor_default/.test(unit.starOrigin || ''))) base.source.starNote = '来源未提供的星级按编辑默认 1 星展示。';
    base.sourceSnapshot = source ? { ...clone(base), sourceSnapshot: undefined, modified: false, origin: 'source_snapshot' } : clone(input.sourceSnapshot || null);
    base.modified = !base.sourceSnapshot || JSON.stringify(base.units) !== JSON.stringify(base.sourceSnapshot.units);
    draft = base; currentId = null; selectedId = null; readOnly = false; dirty = true; screen = 'editor';
    codeResult = null; codeError = ''; paint(); if (notice) notify(notice);
  }
  async function newNote() {
    if (!(await protectUnsaved()) || !mounted()) return;
    draft = blank(); currentId = null; selectedId = null; readOnly = false; dirty = false; screen = 'editor'; code = ''; codeResult = null; codeError = ''; paint();
  }
  async function showHome() {
    if (!(await protectUnsaved()) || !mounted()) return;
    screen = 'home'; draft = blank(); currentId = null; selectedId = null; readOnly = false; dirty = false; codeResult = null; codeError = ''; paint();
  }
  function save(asNew = false) {
    if (readOnly) return;
    try {
      const saved = store.save({ ...draft, id: asNew ? undefined : currentId || undefined }, { id: asNew ? undefined : currentId || undefined });
      draft = saved; currentId = saved.id; dirty = false; storageError = ''; screen = 'home'; noteSearch = ''; notePatchFilter = ''; paint(); notify(asNew ? '已另存为新笔记。' : '个人阵容笔记已保存。');
    } catch (error) { storageError = error.message; paint(); notify(error.message, true); }
  }
  async function load(id) {
    if (!(await protectUnsaved()) || !mounted()) return;
    try {
      const result = store.load(id); draft = result.note; currentId = id; selectedId = null; readOnly = result.readOnly; dirty = false; screen = 'editor'; codeResult = null; codeError = ''; storageError = ''; paint();
    } catch (error) { notify(error.message, true); }
  }
  async function remove(id) {
    if (id === currentId && !(await protectUnsaved())) return;
    if (!mounted()) return;
    try {
      store.remove(id); if (id === currentId) { draft = blank(); currentId = null; selectedId = null; readOnly = false; dirty = false; screen = 'home'; }
      paint(); notify('已移入回收站，可恢复最近 20 份删除的笔记。');
    } catch (error) { notify(error.message, true); }
  }
  function exportNote() {
    try { fileDownload(store.exportJson(draft), `${(draft.title || '个人阵容').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.tft-notes.json`); }
    catch (error) { notify(error.message, true); }
  }
  async function importFile(event) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file) return;
    if (file.size > TEAM_NOTE_LIMITS.importBytes) { notify('阵容 JSON 须小于 256 KB。', true); return; }
    if (!(await protectUnsaved()) || !mounted()) return;
    importBusy = true; paint();
    try { const input = store.importJson(await file.text()); if (mounted()) adopt(input, { notice: '已导入完整个人笔记，请保存到阵容池。' }); }
    catch (error) { if (mounted()) notify(error.message, true); }
    finally { importBusy = false; if (mounted()) paint(); }
  }
  async function decodeCode() {
    if (codeBusy || !code.trim()) return;
    codeBusy = true; codeError = ''; codeResult = null; const requested = code.trim(); paint();
    try {
      const result = await api('/api/team-code/decode', { code: requested });
      if (!mounted()) return;
      if (lineupContextKey(result.context) !== lineupContextKey(catalog.context)) throw new Error('此阵容码与当前资料库版本不匹配。');
      codeResult = result;
    } catch (error) { if (mounted()) codeError = error.message || '阵容码解析失败。'; }
    finally { codeBusy = false; if (mounted()) paint(); }
  }
  async function importCode(withSource = false) {
    const result = codeResult;
    if (!result || !(await protectUnsaved()) || !mounted()) return;
    try {
      const layout = withSource ? result.sourceLayout : null;
      if (withSource && !layout) return;
      const rawUnits = layout?.units || result.units;
      // Null source stars are an editor default, never an encoded value.
      const units = rawUnits.map(unit => ({ instanceId: unit.instanceId, championId: unit.championId,
        items: layout ? [...(unit.items || [])] : [], cell: layout ? (unit.cell ? { ...unit.cell } : null) : null, star: layout && [1, 2, 3].includes(unit.star) ? unit.star : 1 }));
      const source = layout?.source ? clone(layout.source) : null;
      if (source && layout.coordinateSystem?.frontRowY == null) source.positionNote = '来源坐标的前后排方向未核验，请自行确认。';
      if (source && rawUnits.some(unit => ![1, 2, 3].includes(unit.star))) source.starNote = '来源未提供的星级按编辑默认 1 星展示。';
      adopt({ ...blank(), title: source?.name || '导入阵容', context: layout?.context || result.context, units, source }, {
        source: Boolean(layout), notice: layout ? '额外带入了本地来源的站位、装备；它们不包含在原生阵容码内。' : '已导入英雄名单，棋子置于备战席；装备、站位和星级由你编辑。',
      });
    } catch (error) { notify(error.message, true); }
  }
  async function copyCode() {
    try {
      const result = await api('/api/team-code/encode', { units: draft.units });
      if (!mounted()) return;
      if (!result.code) throw new Error('当前阵容不能生成 PC 阵容码。');
      try { await navigator.clipboard.writeText(result.code); notify('已复制 PC 英雄名单码；完整站位、装备和关注项请导出 JSON。'); }
      catch { code = result.code; codeResult = null; paint(); notify('复制权限未开启，阵容码已填入导入框，可手动复制。'); }
    } catch (error) { if (mounted()) notify(error.message, true); }
  }
  function addChampion(championId) {
    if (draft.units.length >= TEAM_NOTE_LIMITS.units) { notify(`个人笔记最多记录 ${TEAM_NOTE_LIMITS.units} 个棋子。`, true); return; }
    const instanceId = `u-${uid()}`; const next = { ...draft, units: [...draft.units, { instanceId, championId, items: [], cell: null, star: 1 }] };
    selectedId = instanceId; if (!changeState(next)) selectedId = null;
  }
  function unitEdit(update) {
    const unit = draft.units.find(item => item.instanceId === selectedId); if (!unit) return;
    changeState({ ...draft, units: draft.units.map(item => item.instanceId === selectedId ? { ...item, ...update(unit) } : item) });
  }
  function moveUnit(move) {
    try { changeState(moveLineupUnit(draft, move.instanceId, move.to)); } catch (error) { notify(error.message, true); }
  }
  function restoreSnapshot() {
    if (!draft.sourceSnapshot || readOnly) return;
    changeState({ ...draft, units: clone(draft.sourceSnapshot.units) }); notify('已恢复参考快照中的棋盘，个人文字仍保留。');
  }
  function field(label, key, { multiline = false } = {}) {
    const input = element(multiline ? 'textarea' : 'input', { class: 'tp-input', value: draft[key] || '', readOnly,
      maxlength: multiline ? key === 'strategy' ? TEAM_NOTE_LIMITS.strategy : TEAM_NOTE_LIMITS.text : TEAM_NOTE_LIMITS.title, rows: multiline ? 5 : undefined,
      placeholder: key === 'title' ? '给这套阵容起个名字' : key === 'strategy' ? '升级节奏、过渡和搜牌思路…' : '关键条件、站位提醒和待验证想法…',
      oninput: event => { if (readOnly) return; draft[key] = event.currentTarget.value; dirty = true; if (dirtyBadge) dirtyBadge.textContent = '未保存'; },
    });
    return element('label', { class: 'tp-field' }, element('span', { text: label }), input);
  }
  function versionField() {
    const input = element('input', { class: 'tp-input', value: draft.versionTag?.patch || '', readOnly, maxlength: 12,
      placeholder: '例如 18.4', 'aria-label': '笔记版本', oninput: event => {
        if (readOnly) return;
        const patch = event.currentTarget.value.trim(); draft.versionTag = patch ? { patch, basis: 'personal' } : undefined;
        const badge = host.querySelector('.tp-header .tp-version-tag'); if (badge) badge.textContent = noteVersionLabel(draft);
        dirty = true; if (dirtyBadge) dirtyBadge.textContent = '未保存';
      } });
    return element('label', { class: 'tp-field tp-version-field' }, element('span', { text: '笔记版本' }), input,
      element('small', { class: 'tp-muted', text: draft.versionTag?.basis === 'rules' ? '默认采用当前机制资料补丁，可按实际对局版本修改。' : '为这份笔记单独记录补丁，留空则显示“版本未记录”。' }));
  }
  function importer() {
    const fileInput = element('input', { type: 'file', accept: '.json,application/json', class: 'tp-file', onchange: importFile, disabled: importBusy });
    const box = element('section', { class: 'tp-import' }, element('h3', { text: '带入阵容' }),
      element('div', { class: 'tp-code-row' }, element('input', { class: 'tp-input', value: code, maxlength: 512, disabled: codeBusy, 'aria-label': 'PC 阵容码', placeholder: '粘贴 PC 原生阵容码',
        oninput: event => { code = event.currentTarget.value; codeResult = null; codeError = ''; box.querySelectorAll('.tp-code-preview,.tp-code-error').forEach(node => node.remove()); }, onkeydown: event => { if (event.key === 'Enter') decodeCode(); } }),
      button(codeBusy ? '解析中…' : '解析', decodeCode, { disabled: codeBusy })),
      element('p', { class: 'tp-muted', text: '原生码只含英雄名单。完整装备、站位、关注项和文字笔记用个人 JSON。' }),
      element('div', { class: 'tp-actions' }, button(importBusy ? '读取中…' : '导入个人 JSON', () => fileInput.click(), { disabled: importBusy }), fileInput));
    if (codeError) box.append(element('p', { class: 'tp-error tp-code-error', role: 'alert', text: codeError }));
    if (codeResult) {
      const names = codeResult.units.map(unit => champions.get(unit.championId)?.name || '未收录英雄').join('、');
      const preview = element('div', { class: 'tp-code-preview' }, element('p', { text: `${codeResult.units.length} 名英雄：${names}` }),
        element('div', { class: 'tp-actions' }, button('导入名单（备战席）', () => importCode(false), { primary: true }), codeResult.sourceLayout ? button('带入来源站位 / 装备', () => importCode(true)) : null));
      if (codeResult.sourceLayout) preview.append(element('p', { class: 'tp-muted', text: `匹配本地来源「${codeResult.sourceLayout.source?.name || '阵容'}」；站位、装备独立读取本地快照，不属于码中内容。` }));
      for (const warning of (codeResult.warnings || []).slice(0, 3)) preview.append(element('p', { class: 'tp-muted', text: warning.message || '' }));
      box.append(preview);
    }
    return box;
  }
  function championPicker() {
    const list = element('div', { class: 'tp-champions' });
    function refresh() {
      const query = championSearch.trim().toLocaleLowerCase();
      const found = [...champions.values()].filter(entity => !query || [entity.name, entity.nameEn, ...(entity.aliases || [])].some(name => String(name || '').toLocaleLowerCase().includes(query))).sort((a, b) => (a.cost || 0) - (b.cost || 0) || a.name.localeCompare(b.name, 'zh-CN'));
      list.replaceChildren(...found.map(entity => button(element('span', { class: 'tp-champion-label' }, safeImage(entity), `${entity.name} · ${entity.cost ?? '?'}费`), () => addChampion(entity.id))));
      if (!found.length) list.append(element('p', { class: 'tp-muted', text: '没有匹配的当前版本英雄。' }));
    }
    const input = element('input', { class: 'tp-input', value: championSearch, placeholder: '搜索英雄 / 别名', 'aria-label': '搜索可添加英雄', oninput: event => { championSearch = event.currentTarget.value; refresh(); } });
    refresh(); return element('section', { class: 'tp-panel' }, element('h3', { text: '添加棋子' }), input, list);
  }
  function watchPanel(key) {
    const isWisp = key === 'wispIds'; const label = isWisp ? '法杖' : '海克斯';
    const directory = isWisp ? wisps : augments; const ids = watchIds(key);
    const panel = element('section', { class: 'tp-panel tp-watch-panel', 'aria-label': `留意的${label}` },
      element('div', { class: 'tp-watch-heading' }, element('h3', { text: `留意的${label}` }), element('span', { class: 'tp-muted', text: `${ids.length} / ${TEAM_NOTE_LIMITS.watchlist}` })),
      element('p', { class: 'tp-muted', text: '个人关注项；表示想留意，不表示本局已选或统计推荐。' }));
    if (lineupContextKey(draft.context) !== lineupContextKey(catalog.context)) {
      panel.append(element('p', { class: 'tp-muted', text: `${ids.length} 项旧版本关注已保留，完整内容可导出；当前目录不重新解释旧效果。` })); return panel;
    }
    function entryLabel(entry) {
      const variant = isWisp ? { upgraded: '升级', prismatic: '棱彩' }[entry.upgrade?.variant] : { silver: '银色', gold: '金色', prismatic: '彩色' }[entry.tier];
      return `${entry.name}${variant ? ` · ${variant}` : ''}`;
    }
    function card(entry, watched) {
      const name = entry ? entryLabel(entry) : isWisp && wispsLoading ? '法杖目录读取中' : '留意项暂未收录';
      const row = element('article', { class: `tp-watch-entry${watched ? ' tp-watched' : ''}` },
        element('div', { class: 'tp-watch-entry-head' }, element('span', { class: 'tp-champion-label' }, safeImage(entry), element('strong', { text: name })),
          button(watched ? '移除关注' : ids.includes(entry.id) ? '已留意' : '留意', () => changeWatch(key, entry.id, !watched),
            { disabled: readOnly || !watched && (ids.includes(entry.id) || ids.length >= TEAM_NOTE_LIMITS.watchlist) })));
      if (isWisp && entry?.availability?.status === 'unverified') row.append(element('p', { class: 'tp-watch-availability', text: '仅静态记录 · 可获得性未核验' }));
      if (entry) {
        const details = element('details', { class: 'tp-watch-description' }, element('summary', { text: '查看说明' }),
          element('p', { text: entry.description || '当前目录未提供效果说明。' }));
        if (entry.descriptionIncomplete) details.append(element('p', { class: 'tp-muted', text: '来源说明含未完整解析的字段。' }));
        row.append(details);
      }
      return row;
    }
    const selected = element('div', { class: 'tp-watch-selected' });
    for (const id of ids) {
      const entry = directory.get(id);
      // Keep unknown pending entries removable without displaying an internal ID.
      if (entry) selected.append(card(entry, true));
      else selected.append(element('article', { class: 'tp-watch-entry tp-watched' }, element('div', { class: 'tp-watch-entry-head' },
        element('span', { text: isWisp && wispsLoading ? '法杖目录读取中' : '关注条目暂未核验' }),
        button('移除关注', () => changeWatch(key, id, false), { disabled: readOnly }))));
    }
    if (!ids.length) selected.append(element('p', { class: 'tp-muted', text: '尚未添加关注。' }));
    panel.append(selected);
    if (readOnly) return panel;
    if (isWisp && !wispsReady) {
      panel.append(element('p', { class: wispsError ? 'tp-error' : 'tp-muted', role: 'status', text: wispsLoading ? '正在读取当前版本的本地法杖目录…' : wispsError || '法杖目录尚未就绪。' }));
      if (!wispsLoading) panel.append(button('重读本地目录', loadWispDirectory));
      return panel;
    }
    const results = element('div', { class: 'tp-watch-results' });
    function refresh() {
      const query = watchSearch[key].trim().toLocaleLowerCase();
      if (!query) { results.replaceChildren(element('p', { class: 'tp-muted', text: `输入名称或效果关键词，在当前目录中查找${label}。` })); return; }
      const found = [...directory.values()].filter(entry => [entry.name, entry.nameEn, entry.description, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].some(value => String(value || '').toLocaleLowerCase().includes(query)));
      results.replaceChildren(element('p', { class: 'tp-muted', text: found.length > 20 ? `匹配 ${found.length} 项，显示前 20 项；可继续缩小关键词。` : `匹配 ${found.length} 项` }), ...found.slice(0, 20).map(entry => card(entry, false)));
    }
    panel.append(element('input', { class: 'tp-input', value: watchSearch[key], placeholder: `搜索${label}名称 / 效果`, 'aria-label': `搜索留意的${label}`,
      oninput: event => { watchSearch[key] = event.currentTarget.value; refresh(); } }), results);
    refresh(); return panel;
  }
  function inspector() {
    const unit = draft.units.find(item => item.instanceId === selectedId);
    if (!unit) return element('section', { class: 'tp-panel tp-selection-hint' }, element('p', { text: '点击棋子后，再点击目标格移动；点击占用格会换位。' }), element('p', { class: 'tp-muted', text: '从下方添加英雄，棋子先进入备战席。' }));
    const hero = champions.get(unit.championId); const usedSlots = unit.items.reduce((sum, id) => sum + (items.get(id)?.slotCost || 1), 0);
    const equipped = element('div', { class: 'tp-equipped' }, ...unit.items.map((id, index) => {
      const item = items.get(id);
      return element('div', { class: 'tp-equipped-item' }, safeImage(item), element('span', { text: `${item?.name || '未收录装备'}${(item?.slotCost || 1) > 1 ? `（${item.slotCost}槽）` : ''}` }), button('移除', () => unitEdit(current => ({ items: current.items.filter((_, at) => at !== index) }))));
    }));
    if (!unit.items.length) equipped.append(element('span', { class: 'tp-muted', text: '尚未选择装备' }));
    const star = element('select', { class: 'tp-input tp-star', value: unit.star, 'aria-label': '棋子星级', onchange: event => unitEdit(() => ({ star: Number(event.currentTarget.value) })) }, ...[1, 2, 3].map(value => element('option', { value }, `${value} 星`))); star.value = unit.star;
    const list = element('div', { class: 'tp-item-picker' });
    function refresh() {
      const query = itemSearch.trim().toLocaleLowerCase();
      const all = [...items.values()].filter(item => !query || [item.name, item.nameEn, ...(item.aliases || [])].some(name => String(name || '').toLocaleLowerCase().includes(query)));
      list.replaceChildren(...all.map(item => {
        const disabled = usedSlots + (item.slotCost || 1) > 3 || item.unique === true && unit.items.includes(item.id);
        const choice = button(element('span', { class: 'tp-champion-label' }, safeImage(item), item.name), () => unitEdit(current => ({ items: [...current.items, item.id] })), { disabled });
        choice.title = disabled ? '槽位不足或同英雄独特装备重复' : `${item.name}${item.kind === 'special' ? ' · 个人笔记选择，特殊兼容条件需自行核对' : ''}`; return choice;
      }));
      if (!all.length) list.append(element('p', { class: 'tp-muted', text: '没有匹配的当前版本装备。' }));
    }
    refresh();
    return element('section', { class: 'tp-panel' }, element('div', { class: 'tp-unit-title' }, element('h3', { text: `编辑 ${hero?.name || '棋子'}` }), star,
      button('移至备战席', () => moveUnit({ instanceId: selectedId, to: null }), { disabled: unit.cell == null }),
      button('移除棋子', () => { const next = { ...draft, units: draft.units.filter(item => item.instanceId !== selectedId) }; selectedId = null; changeState(next); }, { danger: true })),
      element('p', { class: 'tp-muted', text: `已用 ${usedSlots} / 3 槽 · 这是个人搭配记录，不验证库存或转职兼容条件。` }), equipped,
      element('input', { class: 'tp-input', value: itemSearch, placeholder: '搜索装备', 'aria-label': '搜索装备', oninput: event => { itemSearch = event.currentTarget.value; refresh(); } }), list);
  }
  function pool() {
    const panel = element('section', { class: 'tp-pool tp-gallery', 'aria-label': '已保存的个人阵容笔记' });
    try {
      const notes = store.list(); const trash = store.listTrash();
      const input = element('input', { class: 'tp-input', type: 'search', value: noteSearch, 'aria-label': '搜索个人笔记', placeholder: '查找阵容名称、英雄或笔记摘要…', oninput: event => { noteSearch = event.currentTarget.value; update(); } });
      const patches = [...new Set(notes.map(note => note.versionTag?.patch || 'unknown'))];
      const patchSelect = element('select', { class: 'tp-input', 'aria-label': '筛选笔记版本', onchange: event => { notePatchFilter = event.currentTarget.value; update(); } },
        element('option', { value: '', text: '全部版本' }), patches.map(patch => element('option', { value: patch, text: patch === 'unknown' ? '版本未记录' : `${patch} 版本` })));
      patchSelect.value = patches.includes(notePatchFilter) ? notePatchFilter : ''; notePatchFilter = patchSelect.value;
      const count = element('span', { class: 'tp-gallery-count', role: 'status' });
      panel.append(element('div', { class: 'tp-gallery-toolbar' }, input, patchSelect, count));
      const entries = element('div', { class: 'tp-note-grid' });
      function update() {
        const query = noteSearch.trim().toLocaleLowerCase();
        const found = notes.filter(note => (!notePatchFilter || (note.versionTag?.patch || 'unknown') === notePatchFilter)
          && (!query || [note.title, note.excerpt, ...note.previewUnits.map(unit => champions.get(unit.championId)?.name || '')].join(' ').toLocaleLowerCase().includes(query)));
        count.textContent = `已保存 ${notes.length} 份${found.length !== notes.length ? ` · 找到 ${found.length} 份` : ''}`;
        entries.replaceChildren(...found.map(note => {
          const waiting = !note.readOnly && note.watchlistCounts.wisps > 0 && !wispsReady;
          const card = element('article', { class: 'tp-note-card', 'data-note-id': note.id });
          const open = element('button', { type: 'button', class: 'tp-note-open', onclick: () => load(note.id), disabled: waiting, 'aria-label': `打开笔记：${note.title}` },
            element('div', { class: 'tp-note-topline' }, element('span', { class: `tp-version-tag${note.versionTag ? '' : ' tp-version-unknown'}`, title: note.versionTag?.basis === 'rules' ? '创建时采用的机制资料补丁标签' : '这份个人笔记记录的补丁', text: noteVersionLabel(note) }), element('span', { class: 'tp-muted', text: `S${note.context.set}` })),
            element('h2', { text: note.title, 'data-no-translate':true }),
            note.previewUnits.length ? roster(note.previewUnits, catalog, true) : element('p', { class: 'tp-muted', text: '尚未记录英雄' }),
            !note.readOnly ? element('div', { class: 'tp-note-traits' }, computeLineupTraits(note.previewUnits, catalog).filter(trait => trait.active).map(trait => element('span', { title: trait.name }, safeImage(trait), `${trait.count} ${trait.name}`))) : null,
            element('p', { class: 'tp-note-excerpt', text: note.excerpt || '还没有写下运营思路。', ...(note.excerpt?{'data-no-translate':true}:{}) }),
            element('div', { class: 'tp-note-meta' }, element('span', { text: `${note.unitCount} 名棋子 · 海克斯 ${note.watchlistCounts.augments} · 法杖 ${note.watchlistCounts.wisps}` }),
              element('time', { datetime: note.updatedAt, text: `更新于 ${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(note.updatedAt))}` })));
          card.append(open, element('div', { class: 'tp-note-footer' }, element('span', { text: note.readOnly ? '旧资料版本 · 只读' : waiting ? '正在载入法杖目录…' : '点击查看与编辑 ↗' }), button('移入回收站', () => remove(note.id), { danger: true })));
          return card;
        }));
        if (!found.length) entries.append(element('div', { class: 'tp-gallery-empty' }, element('span', { class: 'tp-empty-symbol', 'aria-hidden': 'true', text: '⬡' }),
          element('h2', { text: notes.length ? '没有找到这份笔记' : '记录你的第一套阵容' }),
          element('p', { text: notes.length ? '试试其他名称，或切换笔记版本。' : '把站位、装备和运营思路收在一起，下一次打开规划器就能看到。' }),
          !notes.length ? button('＋ 添加新阵容', newNote, { primary: true }) : null));
      }
      update();
      panel.append(entries);
      if (trash.length) {
        const details = element('details', { class: 'tp-trash' }, element('summary', { text: `回收站（${trash.length}）` }), element('p', { class: 'tp-muted', text: '保留最近 20 份删除的笔记；超过上限时最早的一份会移出回收站。' }));
        for (const entry of trash) details.append(element('div', { class: 'tp-trash-row' }, element('span', { text: entry.title }), button('恢复', () => {
          try { store.restore(entry.id); paint(); notify('已恢复到个人阵容池。'); } catch (error) { notify(error.message, true); }
        })));
        panel.append(details);
      }
      panel.append(element('p', { class: 'tp-gallery-storage tp-muted', text: `笔记保存在当前浏览器 · 最多 ${TEAM_NOTE_LIMITS.notes} 份 · 可在编辑页导出 JSON 备份` }));
    } catch (error) { panel.append(element('p', { class: 'tp-error', text: error.message })); }
    return panel;
  }
  function paint() {
    if (!mounted()) return;
    if (unsavedDialog) { pendingPaint = true; return; }
    if (screen === 'home') {
      const fileInput = element('input', { type: 'file', accept: '.json,application/json', class: 'tp-file', onchange: importFile, disabled: importBusy });
      host.replaceChildren(element('header', { class: 'tp-header tp-home-header' },
        element('div', {}, element('span', { class: 'eyebrow', text: 'PERSONAL COMP COLLECTION' }), element('h1', { text: '我的阵容池' }), element('p', { class: 'tp-home-description', text: '按版本保存的阵容、装备与运营笔记。' })),
        element('div', { class: 'tp-actions' }, button(importBusy ? '导入中…' : '导入笔记 JSON', () => fileInput.click(), { disabled: importBusy }), fileInput, button('＋ 添加新阵容', newNote, { primary: true }))), pool());
      return;
    }
    dirtyBadge = element('span', { class: `tp-status${readOnly ? ' tp-readonly' : ''}`, text: readOnly ? '旧版本只读' : dirty ? '未保存' : currentId ? '已保存' : '新笔记' });
    const header = element('header', { class: 'tp-header' }, element('div', {}, button('← 我的个人笔记', showHome), element('h1', { class: 'tp-editor-title', text: readOnly ? '查看个人阵容笔记' : currentId ? '编辑个人阵容笔记' : '添加个人阵容笔记' }), element('p', { class: 'tp-muted' }, element('span', { class: 'tp-version-tag', text: noteVersionLabel(draft) }), ` S${draft.context.set}`),
      element('details', { class: 'tp-context-details' }, element('summary', { text: '资料版本' }), element('p', { text: versionLabel(draft.context) }))),
      element('div', { class: 'tp-actions' }, dirtyBadge, button('导出完整 JSON', exportNote)));
    const workspace = element('div', { class: 'tp-workspace' });
    if (readOnly) workspace.append(element('section', { class: 'tp-panel tp-old-version' }, element('h3', { text: '这份笔记属于其他版本' }),
      element('p', { text: `${draft.units.length} 名棋子已保留。当前目录不能校验旧棋子与装备，棋盘编辑已关闭。` }), element('p', { class: 'tp-muted', text: '文字可查看，完整笔记仍可导出；新建空白可开始当前版本的阵容。' })));
    else {
      const board = renderTftBoard({ units: draft.units, catalog, editable: true, selectedInstanceId: selectedId,
        onUnitClick: unit => { selectedId = unit.instanceId; paint(); }, onMove: moveUnit,
        onCellClick: (cell, occupant) => { if (selectedId) moveUnit({ instanceId: selectedId, to: cell }); else if (occupant) { selectedId = occupant.instanceId; paint(); } },
      });
      workspace.append(importer(), element('section', { class: 'tp-panel tp-board-panel' }, element('div', { class: 'tp-board-heading' }, element('h3', { text: `棋盘 · ${draft.units.filter(unit => unit.cell).length} 人上场 / ${draft.units.length} 人记录` }), button('复制 PC 名单码', copyCode, { disabled: draft.units.length === 0 })), board,
        renderLineupSummary({ units: draft.units, catalog })), inspector(), championPicker());
    }
    const aside = element('aside', { class: 'tp-sidebar' }, element('section', { class: 'tp-panel tp-writing' }, field('我的标题', 'title'), versionField(), field('运营思路', 'strategy', { multiline: true }), field('注意事项 / 待验证', 'notes', { multiline: true }),
      element('div', { class: 'tp-actions' }, button(currentId ? '更新笔记' : '保存笔记', () => save(false), { primary: true, disabled: readOnly }), currentId && !readOnly ? button('另存为新笔记', () => save(true)) : null),
      storageError ? element('p', { class: 'tp-error', text: storageError }) : null,
      element('p', { class: 'tp-muted', text: '个人笔记不代表来源实测胜率，修改也不会写入大数据或工作台库存。' })));
    aside.append(watchPanel('augmentIds'), watchPanel('wispIds'));
    if (draft.sourceSnapshot) aside.append(element('section', { class: 'tp-panel tp-provenance' }, element('h3', { text: draft.source?.referenceTrust === 'imported_unverified' ? '导入参考快照（来源未核验）' : '原始来源快照' }),
      element('p', { text: draft.source?.name || draft.sourceSnapshot.source?.name || '来源阵容' }),
      element('p', { class: 'tp-muted', text: draft.modified ? '棋盘已被个人修改；原始快照独立保留。' : '当前棋盘与原始快照一致；此页仍是个人笔记。' }),
      draft.source?.positionNote ? element('p', { class: 'tp-muted', text: draft.source.positionNote }) : null,
      draft.source?.starNote ? element('p', { class: 'tp-muted', text: draft.source.starNote }) : null,
      button(draft.source?.referenceTrust === 'imported_unverified' ? '恢复参考棋盘' : '恢复来源棋盘', restoreSnapshot, { disabled: readOnly })));
    host.replaceChildren(header, element('div', { class: 'tp-layout' }, workspace, aside));
  }
  try {
    const initial = initialLineup || (initialDeck ? createLineupFromDeck(initialDeck, catalog) : null);
    if (initial) adopt(initial, { source: initial.origin === 'source_snapshot' || Boolean(initial.source), notice: '已带入来源阵容，保存后成为你的个人笔记。' }); else paint();
  } catch (error) { paint(); notify(error.message, true); }
  if (!wispsReady) loadWispDirectory();
  return { getLineup: () => clone(draft), hasUnsavedChanges: () => dirty };
}
