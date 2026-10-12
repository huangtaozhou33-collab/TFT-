import { validateLineup, lineupContextKey } from './lineup-model.js';

export const TEAM_NOTES_KEY = 'tft.atelier.teamnotes.v2';
export const TEAM_NOTE_FORMAT = 'tft_personal_lineup';
export const TEAM_NOTE_LIMITS = Object.freeze({ notes: 100, trash: 20, units: 28, watchlist: 40, title: 120, strategy: 20000, text: 12000, importBytes: 262144, storeBytes: 4194304 });
const STORE_FORMAT = 'tft_personal_lineup_pool';
// Legacy tabs only accept v2. Once version tags are saved, v3 prevents those tabs from stripping them.
const STORE_SCHEMA = 3;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const clone = value => JSON.parse(JSON.stringify(value));
const bytes = value => new TextEncoder().encode(value).byteLength;

export class TeamNoteError extends Error {
  constructor(code, message) { super(message); this.name = 'TeamNoteError'; this.code = code; }
}
function fail(code, message) { throw new TeamNoteError(code, message); }
function text(value, limit, label) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > limit) fail('INVALID_TEXT', `${label}须为不超过 ${limit} 字的文字。`);
  return value;
}
function cleanContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONTEXT', '笔记缺少有效版本信息。');
  const out = {};
  for (const key of ['game', 'set', 'mutator', 'assetVersion', 'rulesVersion', 'cacheKey', 'sourcePatch', 'gamePatch', 'fetchedAt']) {
    if (value[key] == null) continue;
    if (!['string', 'number'].includes(typeof value[key]) || String(value[key]).length > 240) fail('INVALID_CONTEXT', '笔记版本信息无效。');
    out[key] = value[key];
  }
  if (value.set == null || value.assetVersion == null || value.rulesVersion == null) fail('INVALID_CONTEXT', '笔记缺少赛季、资源或规则版本。');
  if (!Number.isSafeInteger(value.set) || value.set < 1 || typeof value.assetVersion !== 'string' || !/^\d+\.\d+$/.test(value.assetVersion)
    || typeof value.rulesVersion !== 'string' || !value.rulesVersion || typeof value.game !== 'string' || typeof value.mutator !== 'string' || !value.mutator) fail('INVALID_CONTEXT', '笔记版本字段类型无效。');
  return out;
}
const PATCH_TAG = /^\d{1,3}\.\d{1,3}[a-z]?$/i;
function cleanVersionTag(value) {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.patch !== 'string' || !PATCH_TAG.test(value.patch)
    || !['personal', 'game', 'rules'].includes(value.basis)) fail('INVALID_NOTE_VERSION', '笔记版本须类似 18.4；请填写实际补丁或留空。');
  return { patch: value.patch, basis: value.basis };
}
export function defaultNoteVersion(context = {}, rulesPatch) {
  if (typeof context.gamePatch === 'string' && PATCH_TAG.test(context.gamePatch)) return { patch: context.gamePatch, basis: 'game' };
  if (typeof rulesPatch === 'string' && PATCH_TAG.test(rulesPatch)) return { patch: rulesPatch, basis: 'rules' };
  return undefined;
}
export function noteVersionLabel(note) { return note?.versionTag?.patch ? `${note.versionTag.patch} 版本` : '版本未记录'; }
function assertSafeTree(value, depth = 0) {
  if (depth > 12) fail('INVALID_JSON', 'JSON 嵌套过深。');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) fail('INVALID_JSON', 'JSON 含不支持的字段。');
    assertSafeTree(item, depth + 1);
  }
}
function cleanSource(value) {
  if (!value) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SOURCE', '来源快照格式无效。');
  const out = {};
  for (const key of ['id', 'name', 'teamCode', 'positionNote', 'starNote', 'referenceTrust']) if (value[key] != null) out[key] = text(value[key], key === 'teamCode' ? 512 : 500, '来源字段');
  if (value.evidence && typeof value.evidence === 'object' && !Array.isArray(value.evidence)) {
    const evidence = {};
    for (const key of ['source', 'name', 'url', 'endpoint', 'tool', 'set', 'sourcePatch', 'gamePatch', 'assetVersion', 'rulesVersion', 'cacheKey', 'queue', 'rank', 'fetchedAt', 'sourceTime', 'delivery']) {
      const item = value.evidence[key];
      if (item == null || ['string', 'number', 'boolean'].includes(typeof item)) {
        if (typeof item === 'string' && item.length > 1000) fail('INVALID_SOURCE', '来源字段过长。');
        if (Object.hasOwn(value.evidence, key)) evidence[key] = item;
      }
    }
    out.evidence = evidence;
  }
  if (value.stats && typeof value.stats === 'object') {
    out.stats = {};
    for (const key of ['avgPlacement', 'top4Rate', 'winRate', 'sampleSize', 'pickRate']) {
      if (Number.isFinite(value.stats[key]) && value.stats[key] >= 0) out.stats[key] = value.stats[key];
    }
  }
  return out;
}
function cleanUnitsShape(units) {
  if (!Array.isArray(units) || units.length > TEAM_NOTE_LIMITS.units) fail('INVALID_LINEUP', `阵容须为至多 ${TEAM_NOTE_LIMITS.units} 个棋子的列表。`);
  const instanceIds = new Set();
  const cells = new Set();
  return units.map(unit => {
    if (!unit || typeof unit !== 'object' || typeof unit.instanceId !== 'string' || !unit.instanceId || unit.instanceId.length > 160 || FORBIDDEN.has(unit.instanceId) || instanceIds.has(unit.instanceId)) fail('INVALID_LINEUP', '棋子实例标识无效或重复。');
    instanceIds.add(unit.instanceId);
    if (typeof unit.championId !== 'string' || !unit.championId || unit.championId.length > 160 || FORBIDDEN.has(unit.championId)) fail('INVALID_LINEUP', '英雄标识无效。');
    if (!Array.isArray(unit.items) || unit.items.length > 3 || unit.items.some(id => typeof id !== 'string' || !id || id.length > 160 || FORBIDDEN.has(id))) fail('INVALID_LINEUP', '棋子装备列表无效。');
    if (![1, 2, 3].includes(unit.star)) fail('INVALID_LINEUP', '棋子星级须为 1、2 或 3。');
    let cell = null;
    if (unit.cell != null) {
      const { x, y } = unit.cell;
      if (!Number.isInteger(x) || x < 1 || x > 7 || !Number.isInteger(y) || y < 1 || y > 4) fail('INVALID_LINEUP', '棋盘坐标超出 7×4 棋盘。');
      const key = `${x}:${y}`;
      if (cells.has(key)) fail('INVALID_LINEUP', '两个棋子不能占据同一格。');
      cells.add(key); cell = { x, y };
    }
    return { instanceId: unit.instanceId, championId: unit.championId, items: [...unit.items], cell, star: unit.star };
  });
}
function cleanWatchlist(value, catalog = null) {
  if (value == null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('INVALID_WATCHLIST', '留意项须为海克斯与法杖 ID 列表。');
  const out = {};
  for (const [key, directory, label] of [['augmentIds', 'augments', '海克斯'], ['wispIds', 'charms', '法杖']]) {
    const ids = value[key] === undefined ? [] : value[key];
    if (!Array.isArray(ids) || ids.length > TEAM_NOTE_LIMITS.watchlist || ids.some(id => typeof id !== 'string' || !id || id.length > 160 || FORBIDDEN.has(id))) fail('INVALID_WATCHLIST', `每类最多留意 ${TEAM_NOTE_LIMITS.watchlist} 项，且须使用有效目录 ID。`);
    out[key] = [...new Set(ids)];
    if (!catalog || !out[key].length) continue;
    if (!Array.isArray(catalog[directory])) fail('WATCH_DIRECTORY_UNAVAILABLE', `${label}目录尚未就绪，暂不能校验或保存这些留意项。`);
    const known = new Set(catalog[directory].map(item => item.id));
    if (out[key].some(id => !known.has(id))) fail(key === 'augmentIds' ? 'UNKNOWN_WATCH_AUGMENT' : 'UNKNOWN_WATCH_WISP', `留意的${label}不属于当前版本目录，未改写笔记。`);
  }
  return out;
}
function basicLineup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_LINEUP', '阵容格式无效。');
  if (value.schemaVersion !== 2) fail('INVALID_LINEUP', '阵容笔记内部版本无效。');
  const versionTag = cleanVersionTag(value.versionTag);
  return { schemaVersion: 2, ...(versionTag ? { versionTag } : {}), title: text(value.title, TEAM_NOTE_LIMITS.title, '标题'),
    strategy: text(value.strategy, TEAM_NOTE_LIMITS.strategy, '运营说明'), notes: text(value.notes, TEAM_NOTE_LIMITS.text, '注意事项'),
    context: cleanContext(value.context), units: cleanUnitsShape(value.units), source: cleanSource(value.source), watchlist: cleanWatchlist(value.watchlist) };
}
function validatedLineup(value, catalog) {
  const lineup = basicLineup(value);
  if (lineupContextKey(lineup.context) !== lineupContextKey(catalog.context)) fail('VERSION_MISMATCH', '笔记版本与当前资料库不匹配，不能导入或修改。');
  lineup.watchlist = cleanWatchlist(lineup.watchlist, catalog);
  const result = validateLineup(lineup, catalog, { allowUnplaced: true });
  if (!result.valid) fail('INVALID_LINEUP', result.errors?.[0]?.message || '阵容未通过英雄、装备或站位校验。');
  return { ...lineup, units: cleanUnitsShape(result.lineup.units) };
}
function normalizedNote(value, catalog, { current = true } = {}) {
  const lineup = current ? validatedLineup(value, catalog) : basicLineup(value);
  const snapshot = value.sourceSnapshot == null ? null : (current ? validatedLineup(value.sourceSnapshot, catalog) : basicLineup(value.sourceSnapshot));
  if (snapshot && lineupContextKey(snapshot.context) !== lineupContextKey(lineup.context)) fail('INVALID_SOURCE', '来源快照须与笔记属于同一版本。');
  return { ...lineup, origin: 'personal_note', sourceSnapshot: snapshot,
    modified: snapshot ? JSON.stringify(lineup.units) !== JSON.stringify(snapshot.units) : true };
}
function isoNow(clock) {
  const value = clock(); const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) fail('INVALID_CLOCK', '保存时间无效。');
  return date.toISOString();
}
function validRecord(value) {
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 160 || FORBIDDEN.has(value.id)) fail('STORE_CORRUPT', '本地笔记记录无效，未覆盖旧数据。');
  const note = normalizedNote(value, null, { current: false });
  for (const key of ['createdAt', 'updatedAt']) if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))) fail('STORE_CORRUPT', '本地笔记时间无效，未覆盖旧数据。');
  return { ...note, id: value.id, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function makeId() { return globalThis.crypto?.randomUUID?.() || `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }

/** Moving onto an occupied hex swaps the occupant to the previous hex or bench. */
export function moveLineupUnit(lineup, instanceId, to) {
  const units = cleanUnitsShape(lineup?.units);
  const unit = units.find(item => item.instanceId === instanceId);
  if (!unit) fail('NOT_FOUND', '请先选择一个棋子。');
  if (to != null && (!Number.isInteger(to.x) || to.x < 1 || to.x > 7 || !Number.isInteger(to.y) || to.y < 1 || to.y > 4)) fail('INVALID_LINEUP', '目标坐标超出棋盘。');
  const target = to == null ? null : { x: to.x, y: to.y };
  const occupant = target && units.find(item => item.instanceId !== instanceId && item.cell?.x === target.x && item.cell?.y === target.y);
  if (occupant) occupant.cell = unit.cell == null ? null : { ...unit.cell };
  unit.cell = target;
  return { ...lineup, units };
}

/** All mutations write atomically before returning; previous keys and browser data are untouched. */
export function createTeamNotesStore({ storage = globalThis.localStorage, catalog, clock = () => new Date(), idFactory = makeId } = {}) {
  if (!catalog?.context) fail('INVALID_CONTEXT', '保存阵容需要当前资料库版本。');
  const contextKey = lineupContextKey(catalog.context);
  const readOnly = note => lineupContextKey(note.context) !== contextKey;
  function read() {
    let raw;
    try { raw = storage?.getItem(TEAM_NOTES_KEY); } catch { fail('STORAGE_UNAVAILABLE', '浏览器未允许读取本地阵容笔记。'); }
    if (!storage || typeof storage.setItem !== 'function') fail('STORAGE_UNAVAILABLE', '浏览器未允许本地保存。');
    if (raw == null) return { format: STORE_FORMAT, schemaVersion: STORE_SCHEMA, notes: [], trash: [] };
    if (bytes(raw) > TEAM_NOTE_LIMITS.storeBytes) fail('STORE_CORRUPT', '本地笔记数据过大，未覆盖旧数据。');
    let envelope;
    try { envelope = JSON.parse(raw); assertSafeTree(envelope); } catch { fail('STORE_CORRUPT', '本地笔记无法读取，未覆盖旧数据。'); }
    if (envelope?.format !== STORE_FORMAT || ![2, STORE_SCHEMA].includes(envelope.schemaVersion) || !Array.isArray(envelope.notes) || !Array.isArray(envelope.trash) || envelope.notes.length > TEAM_NOTE_LIMITS.notes || envelope.trash.length > TEAM_NOTE_LIMITS.trash) fail('STORE_CORRUPT', '本地笔记格式无效，未覆盖旧数据。');
    const notes = envelope.notes.map(validRecord);
    const trash = envelope.trash.map(entry => {
      if (!entry || !Number.isFinite(Date.parse(entry.deletedAt))) fail('STORE_CORRUPT', '回收站记录无效。');
      return { note: validRecord(entry.note), deletedAt: entry.deletedAt };
    });
    if (new Set([...notes, ...trash.map(entry => entry.note)].map(note => note.id)).size !== notes.length + trash.length) fail('STORE_CORRUPT', '本地笔记标识重复，未覆盖旧数据。');
    return { format: STORE_FORMAT, schemaVersion: STORE_SCHEMA, notes, trash };
  }
  function write(envelope) {
    const serialized = JSON.stringify(envelope);
    if (bytes(serialized) > TEAM_NOTE_LIMITS.storeBytes) fail('STORAGE_LIMIT', '笔记空间已满，请先导出备份。');
    try { storage.setItem(TEAM_NOTES_KEY, serialized); } catch { fail('STORAGE_UNAVAILABLE', '本地保存失败，旧笔记仍保留。请检查浏览器存储空间。'); }
  }
  const summary = note => ({ id: note.id, title: note.title || '未命名阵容', context: clone(note.context), unitCount: note.units.length,
    ...(note.versionTag ? { versionTag: clone(note.versionTag) } : {}), previewUnits: clone(note.units.slice(0, 12)), excerpt: (note.strategy || note.notes).slice(0, 140),
    watchlistCounts: { augments: note.watchlist.augmentIds.length, wisps: note.watchlist.wispIds.length },
    createdAt: note.createdAt, updatedAt: note.updatedAt, readOnly: readOnly(note), modified: note.modified });
  return {
    list() { return read().notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary); },
    listTrash() { return read().trash.map(entry => ({ ...summary(entry.note), deletedAt: entry.deletedAt })); },
    load(id) {
      const note = read().notes.find(item => item.id === id);
      if (!note) fail('NOT_FOUND', '这份阵容笔记不存在。');
      if (!readOnly(note)) validatedLineup(note, catalog);
      return { note: clone(note), readOnly: readOnly(note), reason: readOnly(note) ? '版本不匹配，仅可查看文字和导出备份。' : null };
    },
    save(input, { id = input?.id } = {}) {
      const envelope = read(); const existing = id == null ? null : envelope.notes.find(note => note.id === id);
      if (id != null && !existing) fail('NOT_FOUND', '无法更新不存在的笔记，请另存为新笔记。');
      if (existing && readOnly(existing)) fail('VERSION_MISMATCH', '旧版本笔记只读，不能覆盖。');
      if (!existing && envelope.notes.length >= TEAM_NOTE_LIMITS.notes) fail('NOTE_LIMIT', `阵容池最多保存 ${TEAM_NOTE_LIMITS.notes} 份笔记。`);
      const note = normalizedNote({ ...input, sourceSnapshot: existing ? existing.sourceSnapshot : input?.sourceSnapshot }, catalog);
      const now = isoNow(clock); const noteId = existing?.id || idFactory();
      if (typeof noteId !== 'string' || !noteId || FORBIDDEN.has(noteId) || noteId.length > 160 || (!existing && [...envelope.notes, ...envelope.trash.map(entry => entry.note)].some(item => item.id === noteId))) fail('INVALID_ID', '新笔记标识无效或重复。');
      const saved = { ...note, id: noteId, createdAt: existing?.createdAt || now, updatedAt: now };
      if (existing) envelope.notes[envelope.notes.indexOf(existing)] = saved; else envelope.notes.push(saved);
      write(envelope); return clone(saved);
    },
    remove(id) {
      const envelope = read(); const index = envelope.notes.findIndex(note => note.id === id);
      if (index < 0) fail('NOT_FOUND', '这份阵容笔记不存在。');
      const [note] = envelope.notes.splice(index, 1);
      envelope.trash.unshift({ note, deletedAt: isoNow(clock) }); envelope.trash = envelope.trash.slice(0, TEAM_NOTE_LIMITS.trash);
      write(envelope); return { id, recoverable: true };
    },
    restore(id) {
      const envelope = read(); const index = envelope.trash.findIndex(entry => entry.note.id === id);
      if (index < 0) fail('NOT_FOUND', '回收站中没有这份笔记。');
      if (envelope.notes.length >= TEAM_NOTE_LIMITS.notes) fail('NOTE_LIMIT', '阵容池已满，请先导出或删除其他笔记。');
      const [{ note }] = envelope.trash.splice(index, 1); envelope.notes.push(note); write(envelope); return clone(note);
    },
    exportJson(input) {
      const note = normalizedNote(input, catalog, { current: false });
      return JSON.stringify({ format: TEAM_NOTE_FORMAT, schemaVersion: 2, exportedAt: isoNow(clock), note }, null, 2);
    },
    importJson(raw) {
      if (typeof raw !== 'string' || bytes(raw) > TEAM_NOTE_LIMITS.importBytes) fail('IMPORT_TOO_LARGE', '阵容 JSON 须小于 256 KB。');
      let payload;
      try { payload = JSON.parse(raw); } catch { fail('INVALID_JSON', '无法解析阵容 JSON。'); }
      assertSafeTree(payload);
      if (payload?.format !== TEAM_NOTE_FORMAT || payload.schemaVersion !== 2) fail('UNSUPPORTED_FORMAT', '仅支持 TFT 个人阵容 JSON；这不是官方 PC 阵容码。');
      const imported = normalizedNote(payload.note, catalog);
      // A user's JSON is a personal reference, never authenticated OP.GG evidence.
      for (const lineup of [imported, imported.sourceSnapshot]) if (lineup?.source) {
        lineup.source.referenceTrust = 'imported_unverified'; delete lineup.source.stats;
      }
      return clone(imported);
    },
  };
}
