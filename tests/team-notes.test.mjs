import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamNotesStore, moveLineupUnit, TEAM_NOTES_KEY, TEAM_NOTE_FORMAT, TEAM_NOTE_LIMITS, defaultNoteVersion, noteVersionLabel } from '../public/team-notes.js';
import { validateLineup } from '../public/lineup-model.js';

const context = { game: 'tft', set: 18, mutator: 'DA', assetVersion: '16.20', rulesVersion: 'v3' };
const catalog = { context, champions: [{ id: 'azir', name: '阿兹尔' }, { id: 'maokai', name: '茂凯' }],
  augments: [{ id: 'hex_a', name: '海克斯甲' }, { id: 'hex_b', name: '海克斯乙' }],
  charms: [{ id: 'wisp_a', name: '法杖甲' }, { id: 'wisp_b', name: '法杖乙' }],
  items: [{ id: 'gloves', name: '窃贼手套', slotCost: 3, unique: true, kind: 'completed' },
    { id: 'blade', name: '无尽之刃', slotCost: 1, kind: 'completed' },
    { id: 'emblem', name: '法师纹章', slotCost: 1, unique: true, kind: 'special', allocationVerified: false }] };
class MemoryStorage {
  values = new Map([['tft.atelier.draft.v1', '{"keep":"draft"}'], ['tft.atelier.saved.v1', '["legacy"]']]);
  failWrite = false;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.failWrite) throw new Error('quota'); this.values.set(key, value); }
}
function fixture() {
  const storage = new MemoryStorage(); let tick = 0, serial = 0;
  const opts = { storage, catalog, clock: () => new Date(Date.UTC(2026, 9, 8, 0, 0, tick++)), idFactory: () => `note-${++serial}` };
  return { storage, store: createTeamNotesStore(opts), opts };
}
const unit = (instanceId = 'u1', championId = 'azir', items = [], cell = { x: 1, y: 1 }) => ({ instanceId, championId, items, cell, star: 1 });
const lineup = (changes = {}) => ({ schemaVersion: 2, title: '我的法师', strategy: '先稳血，再上八', notes: '法杖条件仍待验证', context, units: [unit()], ...changes });
const payload = value => JSON.stringify({ format: TEAM_NOTE_FORMAT, schemaVersion: 2, note: value });
const rejects = (operation, code) => assert.throws(operation, error => error.code === code);

test('gallery summaries keep each note patch, hero preview and text through save, JSON and recovery', () => {
  const { store, storage, opts } = fixture();
  const first = store.save(lineup({ title:'18.3 法师', versionTag:{patch:'18.3',basis:'personal'} }));
  const second = store.save(lineup({ title:'18.4 法师', versionTag:defaultNoteVersion(context,'18.4') }));
  const third = store.save(lineup({ title:'未标版本的旧笔记' }));
  const notes = createTeamNotesStore(opts).list();
  assert.equal(notes.length,3);
  assert.deepEqual(notes.map(noteVersionLabel),['版本未记录','18.4 版本','18.3 版本']);
  assert.deepEqual(notes[1].versionTag,{patch:'18.4',basis:'rules'});
  assert.equal(notes[1].previewUnits[0].championId,'azir');
  assert.equal(notes[1].excerpt,'先稳血，再上八');
  notes[1].previewUnits[0].championId='maokai'; notes[1].versionTag.patch='99.1';
  assert.equal(store.load(second.id).note.units[0].championId,'azir');
  assert.equal(store.load(second.id).note.versionTag.patch,'18.4');
  const imported = store.importJson(store.exportJson(store.load(second.id).note));
  assert.deepEqual(imported.versionTag,{patch:'18.4',basis:'rules'});
  store.save({...imported,title:'从 JSON 导入的笔记'});
  store.remove(first.id); assert.equal(store.listTrash()[0].versionTag.patch,'18.3');
  store.restore(first.id); assert.equal(store.load(first.id).note.versionTag.patch,'18.3');
  assert.equal(store.load(third.id).note.versionTag,undefined,'old notes never borrow the current rules patch');
  assert.equal(JSON.parse(storage.getItem(TEAM_NOTES_KEY)).schemaVersion,3);
});

test('legacy v2 notes are read without writes or backfilling their patch; the first mutation preserves them', () => {
  const {store,storage,opts} = fixture(); const old = store.save(lineup());
  const envelope=JSON.parse(storage.getItem(TEAM_NOTES_KEY));envelope.schemaVersion=2;
  const raw=JSON.stringify(envelope);storage.setItem(TEAM_NOTES_KEY,raw);
  const migrated=createTeamNotesStore(opts);assert.equal(noteVersionLabel(migrated.list()[0]),'版本未记录');
  assert.equal(storage.getItem(TEAM_NOTES_KEY),raw,'browsing must not mutate local data');
  migrated.save(lineup({versionTag:{patch:'18.4',basis:'personal'}}));
  assert.deepEqual(migrated.load(old.id).note,old);
  const saved=JSON.parse(storage.getItem(TEAM_NOTES_KEY));assert.equal(saved.schemaVersion,3);
  assert.equal(saved.notes[0].versionTag,undefined);assert.equal(saved.notes[0].createdAt,old.createdAt);
  assert.deepEqual(saved.notes[0].units,old.units);
});

test('note tags distinguish a game patch from a rules default and reject invalid imports atomically', () => {
  assert.deepEqual(defaultNoteVersion({...context,gamePatch:'18.5'},'18.4'),{patch:'18.5',basis:'game'});
  assert.deepEqual(defaultNoteVersion(context,'18.4'),{patch:'18.4',basis:'rules'});
  assert.equal(defaultNoteVersion(context),undefined);
  assert.equal(defaultNoteVersion(context,'set18-assets16.20-recipes18.4-v4'),undefined);
  const {store,storage}=fixture();store.save(lineup());const before=storage.getItem(TEAM_NOTES_KEY);
  for(const tag of [{patch:'<script>',basis:'personal'},{patch:'18.4',basis:'observed'},{patch:18.4,basis:'game'},'18.4']) {
    rejects(()=>store.importJson(payload(lineup({versionTag:tag}))),'INVALID_NOTE_VERSION');
    rejects(()=>store.save(lineup({versionTag:tag})),'INVALID_NOTE_VERSION');
  }
  assert.equal(storage.getItem(TEAM_NOTES_KEY),before);
});

test('notes persist across store instances, update atomically, and preserve other local keys', () => {
  const { store, storage, opts } = fixture();
  const first = store.save(lineup({ title: '<img src=x onerror=alert(1)>', notes: '<script>literal notes</script>' }));
  assert.equal(first.origin, 'personal_note');
  assert.equal(first.id, 'note-1');
  const loaded = createTeamNotesStore(opts).load(first.id);
  assert.equal(loaded.readOnly, false);
  assert.equal(loaded.note.notes, '<script>literal notes</script>', 'free text stays literal; UI must use text nodes');
  loaded.note.units[0].cell.x = 7;
  assert.equal(store.load(first.id).note.units[0].cell.x, 1, 'returned objects cannot mutate persisted notes');
  const updated = store.save({ ...first, title: '更新标题', strategy: '四阶段稳血' });
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.notEqual(updated.updatedAt, first.updatedAt);
  assert.equal(store.list().length, 1);
  assert.equal(store.load(first.id).note.strategy, '四阶段稳血');
  assert.equal(storage.getItem('tft.atelier.draft.v1'), '{"keep":"draft"}');
  assert.equal(storage.getItem('tft.atelier.saved.v1'), '["legacy"]');
  const before = storage.getItem(TEAM_NOTES_KEY); storage.failWrite = true;
  rejects(() => store.save({ ...updated, notes: '不会被错误地提示保存成功' }), 'STORAGE_UNAVAILABLE');
  assert.equal(storage.getItem(TEAM_NOTES_KEY), before, 'quota failure must retain the exact old storage');
});

test('a source snapshot stays separate and immutable when personal units change', () => {
  const { store } = fixture();
  const source = { id: 'deck-a', name: '来源队伍', stats: { avgPlacement: 3.1, sampleSize: 1200 }, evidence: { source: 'OP.GG', sourcePatch: null } };
  const snapshot = lineup({ source, units: [unit('u1', 'azir', ['blade'])] });
  const saved = store.save({ ...snapshot, sourceSnapshot: snapshot, modified: false });
  assert.equal(saved.modified, false);
  const textOnly = store.save({ ...saved, notes: '仅修改我的文字' });
  assert.equal(textOnly.modified, false);
  const modified = store.save({ ...textOnly, units: [unit('u1', 'maokai', ['emblem'])], modified: false,
    sourceSnapshot: lineup({ units: [] }) });
  assert.equal(modified.modified, true, 'a caller cannot label edited units as observed original performance');
  assert.deepEqual(modified.sourceSnapshot.units, snapshot.units, 'updates cannot replace the original snapshot');
  assert.equal(modified.sourceSnapshot.source.stats.sampleSize, 1200);
  const imported = store.importJson(store.exportJson(modified));
  assert.equal(imported.source.referenceTrust, 'imported_unverified');
  assert.equal(imported.sourceSnapshot.source.referenceTrust, 'imported_unverified');
  assert.equal(imported.source.stats, undefined, 'external JSON cannot authenticate source statistics');
  assert.equal(imported.sourceSnapshot.source.stats, undefined);
});

test('different version notes remain recoverable and readonly without rewriting their entities', () => {
  const { store, storage, opts } = fixture();
  const old = store.save(lineup());
  const newCatalog = { ...catalog, context: { ...context, set: 19, mutator: 'NEXT', rulesVersion: 'v4' }, champions: [] };
  const current = createTeamNotesStore({ ...opts, catalog: newCatalog });
  const before = storage.getItem(TEAM_NOTES_KEY);
  assert.equal(current.list()[0].readOnly, true);
  const loaded = current.load(old.id);
  assert.equal(loaded.readOnly, true);
  assert.equal(loaded.note.units[0].championId, 'azir', 'no replacement with current-season entities');
  rejects(() => current.save({ ...loaded.note, context: newCatalog.context, units: [] }), 'VERSION_MISMATCH');
  rejects(() => current.importJson(store.exportJson(old)), 'VERSION_MISMATCH');
  assert.equal(storage.getItem(TEAM_NOTES_KEY), before);
  const fresh = current.save(lineup({ context: newCatalog.context, units: [] }));
  assert.notEqual(fresh.id, old.id);
  assert.equal(current.list().filter(note => note.readOnly).length, 1);
  assert.equal(current.list().filter(note => !note.readOnly).length, 1);
  assert.ok(JSON.parse(current.exportJson(loaded.note)).note.units.length, 'readonly legacy note can still be backed up');
});

test('delete is reversible with complete content and the trash has an explicit bounded retention', () => {
  const { store } = fixture();
  const saved = store.save(lineup({ units: [unit('a', 'maokai', ['emblem'], null), { ...unit('b', 'azir', ['blade'], { x: 7, y: 4 }), star: 3 }] }));
  store.remove(saved.id);
  assert.equal(store.list().length, 0);
  assert.equal(store.listTrash()[0].id, saved.id);
  rejects(() => store.load(saved.id), 'NOT_FOUND');
  assert.deepEqual(store.restore(saved.id), saved);
  assert.deepEqual(store.load(saved.id).note.units, saved.units);
  assert.equal(store.listTrash().length, 0);
  const removed = [];
  for (let index = 0; index < TEAM_NOTE_LIMITS.trash + 2; index++) {
    const note = store.save(lineup({ title: `备份 ${index}` })); removed.push(note.id); store.remove(note.id);
  }
  assert.equal(store.listTrash().length, TEAM_NOTE_LIMITS.trash);
  rejects(() => store.restore(removed[0]), 'NOT_FOUND');
  assert.equal(store.restore(removed.at(-1)).id, removed.at(-1));
  assert.equal(store.list()[0].id, removed.at(-1));
});

test('personal JSON preserves equipment, hexes, stars, duplicate instances and text, but creates no saved record implicitly', () => {
  const { store } = fixture();
  const input = lineup({ strategy: '1. 过渡\n2. 换位', notes: '中文 & <b>原样文字</b>',
    units: [{ ...unit('front', 'maokai', ['gloves'], { x: 2, y: 4 }), star: 2 },
      { ...unit('back', 'azir', ['blade', 'blade', 'blade'], { x: 6, y: 1 }), star: 3 }, unit('bench', 'azir', ['emblem'], null)] });
  const exported = store.exportJson(input); const parsed = JSON.parse(exported);
  assert.equal(parsed.format, 'tft_personal_lineup');
  assert.notEqual(parsed.format, 'riot_pc', 'full notes are not an official native team code');
  const imported = store.importJson(exported);
  assert.deepEqual(imported.units, input.units);
  assert.equal(imported.notes, input.notes);
  assert.equal(imported.strategy, input.strategy);
  assert.equal(imported.id, undefined);
  assert.equal(store.list().length, 0, 'import previews must not silently overwrite or save');
  assert.equal(validateLineup(imported, catalog).valid, true);
});

test('invalid imports reject exact entity, slot, coordinate, version and format violations without mutation', () => {
  const { store, storage } = fixture(); store.save(lineup()); const before = storage.getItem(TEAM_NOTES_KEY);
  const invalid = [
    lineup({ units: [unit('x', 'unknown')] }),
    lineup({ units: [unit('x', 'azir', ['unknown-item'])] }),
    lineup({ units: [unit('x', 'azir', ['gloves', 'blade'])] }),
    lineup({ units: [unit('x', 'maokai', ['emblem', 'emblem'])] }),
    lineup({ units: [unit('x', 'azir', [], { x: 0, y: 1 })] }),
    lineup({ units: [unit('x', 'azir', [], { x: 1, y: 5 })] }),
    lineup({ units: [unit('x'), unit('y', 'maokai')] }),
    lineup({ units: [unit('same'), unit('same', 'maokai', [], null)] }),
    lineup({ units: [{ ...unit(), star: 4 }] }),
    lineup({ units: [unit('__proto__')] }),
    lineup({ units: Array.from({ length: 29 }, (_, index) => unit(`u${index}`, 'azir', [], null)) }),
    lineup({ schemaVersion: 999 }),
  ];
  for (const value of invalid) rejects(() => store.importJson(payload(value)), 'INVALID_LINEUP');
  rejects(() => store.importJson(payload(lineup({ context: { ...context, game: 'tftm' } }))), 'VERSION_MISMATCH');
  rejects(() => store.importJson(payload(lineup({ context: { ...context, set: '18' } }))), 'INVALID_CONTEXT');
  rejects(() => store.importJson(payload(lineup({ notes: 'x'.repeat(12001) }))), 'INVALID_TEXT');
  rejects(() => store.importJson(JSON.stringify({ format: 'riot_pc', schemaVersion: 2, note: lineup() })), 'UNSUPPORTED_FORMAT');
  rejects(() => store.importJson(JSON.stringify({ format: TEAM_NOTE_FORMAT, schemaVersion: 999, note: lineup() })), 'UNSUPPORTED_FORMAT');
  rejects(() => store.importJson('{'), 'INVALID_JSON');
  rejects(() => store.importJson(' '.repeat(TEAM_NOTE_LIMITS.importBytes + 1)), 'IMPORT_TOO_LARGE');
  rejects(() => store.importJson(`{"format":"${TEAM_NOTE_FORMAT}","schemaVersion":2,"note":{},"__proto__":{"polluted":true}}`), 'INVALID_JSON');
  assert.equal({}.polluted, undefined);
  assert.equal(storage.getItem(TEAM_NOTES_KEY), before);
});

test('hex moves swap board occupants, displace to bench, and keep input immutable', () => {
  const input = lineup({ units: [unit('a', 'maokai', ['emblem'], { x: 1, y: 4 }), unit('b', 'azir', ['blade'], { x: 5, y: 1 }), unit('c', 'azir', [], null)] });
  const original = structuredClone(input);
  const swapped = moveLineupUnit(input, 'a', { x: 5, y: 1 });
  assert.deepEqual(swapped.units.find(unit => unit.instanceId === 'b').cell, { x: 1, y: 4 });
  assert.deepEqual(swapped.units.find(unit => unit.instanceId === 'a').cell, { x: 5, y: 1 });
  const fromBench = moveLineupUnit(swapped, 'c', { x: 5, y: 1 });
  assert.equal(fromBench.units.find(unit => unit.instanceId === 'a').cell, null);
  assert.deepEqual(fromBench.units.find(unit => unit.instanceId === 'c').cell, { x: 5, y: 1 });
  const toBench = moveLineupUnit(fromBench, 'b', null);
  assert.equal(toBench.units.find(unit => unit.instanceId === 'b').cell, null);
  assert.equal(validateLineup(toBench, catalog).valid, true);
  assert.deepEqual(input, original);
  rejects(() => moveLineupUnit(input, 'missing', null), 'NOT_FOUND');
  rejects(() => moveLineupUnit(input, 'a', { x: 8, y: 1 }), 'INVALID_LINEUP');
});

test('corrupt or unavailable storage is never replaced by a fresh pool', () => {
  const { storage, opts } = fixture(); storage.setItem(TEAM_NOTES_KEY, '{bad json');
  const store = createTeamNotesStore(opts);
  rejects(() => store.list(), 'STORE_CORRUPT');
  rejects(() => store.save(lineup()), 'STORE_CORRUPT');
  assert.equal(storage.getItem(TEAM_NOTES_KEY), '{bad json');
  const unavailable = createTeamNotesStore({ catalog, storage: { getItem() { throw new Error('blocked'); }, setItem() {} } });
  rejects(() => unavailable.save(lineup()), 'STORAGE_UNAVAILABLE');
});

test('personal watchlists dedupe, save, update, restore and survive JSON without changing source lineup ownership', () => {
  const { store } = fixture();
  const original = lineup({ source: { id: 'observed', name: '来源示例' } });
  const saved = store.save({ ...original, sourceSnapshot: original,
    watchlist: { augmentIds: ['hex_a', 'hex_a', 'hex_b'], wispIds: ['wisp_b', 'wisp_a', 'wisp_b'] } });
  assert.deepEqual(saved.watchlist, { augmentIds: ['hex_a', 'hex_b'], wispIds: ['wisp_b', 'wisp_a'] });
  assert.equal(saved.modified, false, 'attention items are not changes to the observed source board');
  assert.deepEqual(saved.units, original.units, 'attention does not add champions, items or population');
  assert.deepEqual(store.list()[0].watchlistCounts, { augments: 2, wisps: 2 });
  const imported = store.importJson(store.exportJson(saved));
  assert.deepEqual(imported.watchlist, saved.watchlist);
  assert.deepEqual(imported.units, original.units);
  assert.deepEqual(store.load(saved.id).note.watchlist, saved.watchlist);
  const updated = store.save({ ...saved, watchlist: { augmentIds: [], wispIds: ['wisp_a'] } });
  assert.equal(updated.createdAt, saved.createdAt);
  assert.equal(updated.modified, false);
  store.remove(saved.id); store.restore(saved.id);
  assert.deepEqual(store.load(saved.id).note.watchlist, { augmentIds: [], wispIds: ['wisp_a'] });
});

test('old notes default to empty attention while invalid IDs, directories, shapes and version imports leave storage intact', () => {
  const { store, storage, opts } = fixture(); const saved = store.save(lineup());
  const oldEnvelope = JSON.parse(storage.getItem(TEAM_NOTES_KEY)); delete oldEnvelope.notes[0].watchlist;
  storage.setItem(TEAM_NOTES_KEY, JSON.stringify(oldEnvelope));
  assert.deepEqual(store.load(saved.id).note.watchlist, { augmentIds: [], wispIds: [] });
  assert.deepEqual(store.importJson(payload(lineup())).watchlist, { augmentIds: [], wispIds: [] });
  const before = storage.getItem(TEAM_NOTES_KEY);
  rejects(() => store.importJson(payload(lineup({ watchlist: { augmentIds: ['missing'] } }))), 'UNKNOWN_WATCH_AUGMENT');
  rejects(() => store.importJson(payload(lineup({ watchlist: { wispIds: ['missing'] } }))), 'UNKNOWN_WATCH_WISP');
  rejects(() => store.importJson(payload(lineup({ watchlist: { wispIds: ['hex_a'] } }))), 'UNKNOWN_WATCH_WISP');
  for (const watchlist of [{ augmentIds: 'hex_a' }, { wispIds: [123] }, { wispIds: ['__proto__'] }, { augmentIds: Array(41).fill('hex_a') }]) {
    rejects(() => store.importJson(payload(lineup({ watchlist }))), 'INVALID_WATCHLIST');
  }
  rejects(() => store.importJson(payload(lineup({ context: { ...context, rulesVersion: 'v99' }, watchlist: { wispIds: ['wisp_a'] } }))), 'VERSION_MISMATCH');
  assert.equal(storage.getItem(TEAM_NOTES_KEY), before);
  const note = store.save(lineup({ watchlist: { augmentIds: ['hex_a'], wispIds: ['wisp_a'] } }));
  const pendingCatalog = { ...catalog, charms: undefined }; const pending = createTeamNotesStore({ ...opts, catalog: pendingCatalog });
  assert.deepEqual(pending.list()[0].watchlistCounts, { augments: 1, wisps: 1 }, 'pending cache does not erase persisted attention');
  const pendingBefore = storage.getItem(TEAM_NOTES_KEY);
  rejects(() => pending.load(note.id), 'WATCH_DIRECTORY_UNAVAILABLE');
  rejects(() => pending.save(note), 'WATCH_DIRECTORY_UNAVAILABLE');
  assert.equal(storage.getItem(TEAM_NOTES_KEY), pendingBefore);
  pendingCatalog.charms = catalog.charms;
  assert.deepEqual(pending.load(note.id).note.watchlist, note.watchlist, 'same-version directory becoming ready permits exact ID validation');
});
