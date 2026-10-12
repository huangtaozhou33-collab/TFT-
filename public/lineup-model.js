// Shared, DOM-free model for a personal PC TFT plan. These are planning facts,
// never observations of match performance or an inventory allocation.
export const LINEUP_SCHEMA_VERSION = 2;
export const BOARD_COLUMNS = 7;
export const BOARD_ROWS = 4;
export const MAX_LINEUP_UNITS = 28;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
export function lineupContextKey(context = {}) {
  return [context.game || 'tft', context.set ?? '', context.mutator ?? '', context.assetVersion ?? '', context.rulesVersion ?? ''].join(':');
}
export function validateLineup(input, catalog, { allowUnplaced = true } = {}) {
  const errors = [];
  const fail = (code, message, instanceId) => errors.push({ code, message, ...(instanceId ? { instanceId } : {}) });
  if (!plain(input)) return { valid: false, errors: [{ code: 'INVALID_LINEUP', message: '阵容笔记必须是对象。' }], lineup: null };
  if (input.schemaVersion != null && input.schemaVersion !== LINEUP_SCHEMA_VERSION) fail('INVALID_LINEUP_SCHEMA', '阵容笔记版本不支持。');
  if (!plain(input.context) || input.context.game !== 'tft') fail('PC_TFT_ONLY', '仅支持 PC 云顶之弈 TFT 的阵容笔记。');
  else if (lineupContextKey(input.context) !== lineupContextKey(catalog.context)) fail('LINEUP_VERSION_MISMATCH', '阵容笔记的赛季或资源版本与当前版本不匹配。');
  if (!Array.isArray(input.units) || input.units.length > MAX_LINEUP_UNITS) return { valid: false, errors: [...errors, { code: 'LINEUP_SIZE', message: '阵容必须包含棋子数组，最多28个规划棋子。' }], lineup: null };
  if (input.title != null && (typeof input.title !== 'string' || input.title.length > 120)) fail('INVALID_TITLE', '阵容标题最多120个字符。');
  if (input.notes != null && (typeof input.notes !== 'string' || input.notes.length > 12000)) fail('INVALID_NOTES', '注意事项最多12000个字符。');
  const champions = new Map((catalog.champions || []).map(value => [value.id, value]));
  const items = new Map((catalog.items || []).map(value => [value.id, value]));
  const instances = new Set(), cells = new Set(), normalized = [];
  for (const unit of input.units) {
    if (!plain(unit)) { fail('INVALID_UNIT', '棋子条目无效。'); continue; }
    const instanceId = unit.instanceId;
    if (typeof instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(instanceId) || instances.has(instanceId)) fail('INVALID_INSTANCE', '棋子实例ID缺失或重复。');
    instances.add(instanceId);
    if (!champions.has(unit.championId)) fail('UNKNOWN_CHAMPION', '棋子不属于当前 PC TFT 资料目录。', instanceId);
    if (!Array.isArray(unit.items) || unit.items.length > 3) fail('INVALID_ITEMS', '每名棋子最多携带三件装备。', instanceId);
    const unitItems = Array.isArray(unit.items) ? unit.items : [];
    let slots = 0;
    const uniqueItems = new Set();
    for (const id of unitItems) {
      const item = items.get(id);
      if (!item) { fail('UNKNOWN_ITEM', '装备不属于当前版本目录。', instanceId); continue; }
      slots += Number.isSafeInteger(item.slotCost) && item.slotCost >= 1 ? item.slotCost : 1;
      if (item.unique && uniqueItems.has(id)) fail('UNIQUE_ITEM', '同一棋子不能重复携带唯一装备。', instanceId);
      uniqueItems.add(id);
    }
    if (slots > 3) fail('ITEM_SLOT_LIMIT', '装备占用超过三个槽位，三槽手套不能与其他装备共存。', instanceId);
    if (!Number.isSafeInteger(unit.star) || unit.star < 1 || unit.star > 3) fail('INVALID_STAR', '规划星级必须为1至3星。', instanceId);
    let cell = null;
    if (unit.cell == null) { if (!allowUnplaced) fail('UNPLACED_UNIT', '棋子尚未摆放到棋盘。', instanceId); }
    else if (!plain(unit.cell) || !Number.isSafeInteger(unit.cell.x) || !Number.isSafeInteger(unit.cell.y) || unit.cell.x < 1 || unit.cell.x > BOARD_COLUMNS || unit.cell.y < 1 || unit.cell.y > BOARD_ROWS) fail('INVALID_CELL', '站位坐标必须在7列、4行的棋盘内。', instanceId);
    else {
      cell = { x: unit.cell.x, y: unit.cell.y };
      const key = `${cell.x},${cell.y}`;
      if (cells.has(key)) fail('CELL_OCCUPIED', '两名棋子不能占用同一个格子。', instanceId);
      cells.add(key);
    }
    normalized.push({ instanceId, championId: unit.championId, items: [...unitItems], cell, star: unit.star,
      ...(typeof unit.starOrigin === 'string' ? { starOrigin: unit.starOrigin.slice(0, 80) } : {}) });
  }
  return { valid: errors.length === 0, errors, lineup: errors.length ? null : {
    schemaVersion: LINEUP_SCHEMA_VERSION, title: input.title || '未命名阵容', notes: input.notes || '',
    context: clone(catalog.context), units: normalized,
    origin: input.origin === 'source_snapshot' ? 'source_snapshot' : 'personal', modified: input.modified === true,
    ...(plain(input.source) ? { source: clone(input.source) } : {}),
  } };
}
export function createLineupFromDeck(deck, catalog) {
  return {
    schemaVersion: LINEUP_SCHEMA_VERSION, title: deck.name || '来源阵容', notes: '', context: clone(catalog.context),
    origin: 'source_snapshot', modified: false,
    units: (deck.units || []).map((unit, index) => ({ instanceId: `source-${index}-${unit.id}`, championId: unit.id,
      items: [...(unit.items || [])], cell: unit.cell ? { x: unit.cell.x, y: unit.cell.y } : null,
      star: Number.isSafeInteger(unit.star) && unit.star >= 1 && unit.star <= 3 ? unit.star : 1,
      starOrigin: Number.isSafeInteger(unit.star) ? 'source_example' : 'editor_default_not_provided' })),
    source: { id: deck.id, name: deck.name, teamCode: deck.teamCode ?? null, evidence: clone(deck.evidence), stats: clone(deck.stats),
      note: '来源统计属于原始阵容记录；个人修改不继承实测胜率。' },
  };
}
// The exact current catalog rule supplies Elder Dragon's two-slot exception.
// This is a roster requirement, not an observed player level or a capacity bonus.
export function computeLineupPopulation(units, catalog) {
  const apex = catalog.traits?.find(trait => trait.id === 'DA_18_ApexPredator');
  const elderRule = catalog.context?.set === 18 && /占用2个弈子栏位/.test(apex?.description || '');
  const byId = new Map((catalog.champions || []).map(champion => [champion.id, champion]));
  let requiredSlots = 0;
  const exceptions = [];
  for (const unit of units || []) {
    const champion = byId.get(unit.championId ?? unit.id);
    if (!champion) return { requiredSlots: null, unitCount: units.length, finalLevel: null, exceptions, note: '存在未收录棋子，人口需求未知。' };
    if (champion.id === 'DA_18_ElderDragon' && !elderRule) return { requiredSlots: null, unitCount: units.length, finalLevel: null, exceptions, note: '特殊棋子的人口规则缺失，需求未知。' };
    const twoSlots = elderRule && champion.id === 'DA_18_ElderDragon' && champion.traits?.includes(apex.name);
    requiredSlots += twoSlots ? 2 : 1;
    if (twoSlots) exceptions.push({ championId: champion.id, slots: 2, ruleId: apex.id, source: apex.source });
  }
  return { requiredSlots, unitCount: (units || []).length, finalLevel: null, exceptions,
    note: '所需基础人口含待摆放棋子；远古巨龙按目录规则占两栏。未计皇冠、强化或羁绊的额外容量，不代表来源最终等级。' };
}
export function computeLineupTraits(units, catalog) {
  const champions = new Map((catalog.champions || []).map(value => [value.id, value]));
  const items = new Map((catalog.items || []).map(value => [value.id, value]));
  const traits = new Map((catalog.traits || []).map(value => [value.id, value]));
  const byName = new Map((catalog.traits || []).map(value => [value.name, value]));
  const members = new Map();
  const add = (trait, championId, kind, weight = 1) => {
    if (!trait) return;
    if (!members.has(trait.id)) members.set(trait.id, new Map());
    const previous = members.get(trait.id).get(championId);
    if (!previous || weight > previous.weight) members.get(trait.id).set(championId, { kind, weight });
  };
  // Every unit in the plan participates, including those not yet assigned a hex.
  // Repeated copies of the same champion do not add native or emblem traits.
  for (const unit of units || []) {
    const champion = champions.get(unit.championId);
    if (!champion) continue;
    const avatar = traits.get('DA_18_LuxUniqueTrait');
    const isAvatar = catalog.context?.set === 18 && champion.traits?.includes(avatar?.name)
      && /提供\+2计数/.test(avatar?.description || '');
    const apex = traits.get('DA_18_ApexPredator');
    const isElder = catalog.context?.set === 18 && champion.id === 'DA_18_ElderDragon'
      && champion.traits?.includes(apex?.name) && /提供\+2【峡谷野怪】羁绊/.test(apex?.description || '');
    for (const name of champion.traits || []) add(byName.get(name), champion.id, 'native',
      isAvatar && name !== avatar.name || isElder && name === '峡谷野怪' ? 2 : 1);
    for (const id of unit.items || []) {
      const item = items.get(id);
      if (item?.category !== 'emblem') continue;
      add(traits.get(item.traitId) || byName.get(item.traitName), champion.id, 'emblem');
    }
  }
  return [...members].map(([id, values]) => {
    const trait = traits.get(id), contributions = { native: 0, emblem: 0 };
    for (const member of values.values()) contributions[member.kind] += member.weight;
    const count = contributions.native + contributions.emblem;
    const thresholds = [...new Set((trait.effects || []).map(value => value.minUnits).filter(value => Number.isSafeInteger(value) && value > 0))].sort((a,b) => a-b);
    const activeThreshold = Math.max(0, ...thresholds.filter(value => value <= count));
    return { id, name: trait.name, icon: trait.icon, description: trait.description, count, contributions, thresholds,
      active: activeThreshold > 0, activeThreshold, nextThreshold: thresholds.find(value => value > count) ?? null };
  }).sort((a,b) => Number(b.active)-Number(a.active) || b.activeThreshold-a.activeThreshold || b.count-a.count || a.name.localeCompare(b.name,'zh-CN'));
}
