import { createHash } from 'node:crypto';

/** Validation failures are suitable for returning as 400 responses at the API boundary. */
export class PlannerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
    this.details = details;
  }
}

const ROLES = new Set(['carry', 'tank', 'support']);
const ORIGINS = new Set(['locked', 'inventory', 'crafted']);
const ROLE_TAGS = {
  carry: new Set(['carry', 'damage', 'ad', 'ap', 'attack', 'attackdamage', 'abilitypower', 'physical', 'magic', 'crit', 'critchance', 'attack-speed', 'attackspeed', 'mana', 'offense', '输出', '物理', '法术', '攻速']),
  tank: new Set(['tank', 'health', 'hp', 'armor', 'mr', 'magicresist', 'resist', 'defense', 'defence', 'defensive', 'shield', 'frontline', '坦克', '防御', '生命', '护甲', '魔抗']),
  support: new Set(['support', 'utility', 'aura', 'team', 'shred', 'sunder', 'heal', '辅助', '功能', '团队', '治疗']),
};
const SLOT_WEIGHTS = [1, 0.7, 0.45];
const SEARCH = { beamWidth: 24, movesPerState: 32, maxExpansions: 24_000 };
const LIMITS = { units: 32, inventoryCount: 99, priority: 1_000, preferencesPerUnit: 128 };
const own = (object, key) => Object.hasOwn(object, key);
const countOf = (object, key) => own(object, key) ? object[key] : 0;
const preferenceList = (object, key) => own(object, key) ? object[key] : [];
const fail = (code, message, details) => { throw new PlannerError(code, message, details); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const sameBag = (a, b) => stable([...a].sort()) === stable([...b].sort());
const add = (map, key, count = 1) => {
  Object.defineProperty(map, key, { value: countOf(map, key) + count, enumerable: true, writable: true, configurable: true });
};
const positive = map => Object.fromEntries(Object.entries(map).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b)));
const sortedMap = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));

function normalizeCatalog(catalog) {
  if (!isRecord(catalog) || !Array.isArray(catalog.items) || !Array.isArray(catalog.champions)) {
    fail('INVALID_CATALOG', '目录必须包含 items 和 champions 数组。');
  }
  const items = new Map();
  for (const value of catalog.items) {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name
      || !['component', 'completed', 'special'].includes(value.kind)) {
      fail('INVALID_CATALOG', '装备目录的 ID、名称或分类不合法。');
    }
    if (items.has(value.id)) fail('INVALID_CATALOG', '装备目录存在重复 ID。', { itemId: value.id });
    if (value.unique !== undefined && typeof value.unique !== 'boolean') fail('INVALID_CATALOG', 'unique 必须是布尔值。', { itemId: value.id });
    if (value.slotCost !== undefined && (!Number.isInteger(value.slotCost) || value.slotCost < 1 || value.slotCost > 3)) fail('INVALID_CATALOG', 'slotCost 必须是 1 至 3 的整数。', { itemId: value.id });
    if (value.allocationVerified !== undefined && typeof value.allocationVerified !== 'boolean') fail('INVALID_CATALOG', 'allocationVerified 必须是布尔值。', { itemId: value.id });
    if (value.recipeVerified !== undefined && typeof value.recipeVerified !== 'boolean') fail('INVALID_CATALOG', 'recipeVerified 必须是布尔值。', { itemId: value.id });
    if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string'))) {
      fail('INVALID_CATALOG', '装备 tags 必须是字符串数组。', { itemId: value.id });
    }
    const validRecipeShape = Array.isArray(value.components) && value.components.every(id => typeof id === 'string' && id);
    items.set(value.id, {
      id: value.id, name: value.name, kind: value.kind, unique: value.unique ?? false, slotCost: value.slotCost ?? 1,
      allocationVerified: value.allocationVerified ?? value.kind === 'completed',
      components: validRecipeShape ? [...value.components] : [],
      tags: [...(value.tags ?? [])].map(tag => tag.toLowerCase()).sort(),
      validRecipeShape, recipeVerified: value.recipeVerified !== false,
    });
  }
  for (const item of items.values()) {
    item.craftable = item.kind === 'completed' && item.recipeVerified && item.validRecipeShape && item.components.length === 2
      && item.components.every(id => items.get(id)?.kind === 'component');
    if (item.kind === 'completed' && !item.craftable) item.recipeProblem = item.recipeVerified ? '配方缺失、不是两个散件或含未知/非散件 ID' : '目录已标记配方未验证';
    if (item.kind === 'special') item.recipeProblem = '特殊装备不参与自动合成';
  }
  const champions = new Map();
  for (const champion of catalog.champions) {
    if (!isRecord(champion) || typeof champion.id !== 'string' || !champion.id || typeof champion.name !== 'string' || !champion.name) {
      fail('INVALID_CATALOG', '英雄目录的 ID 或名称不合法。');
    }
    if (champions.has(champion.id)) fail('INVALID_CATALOG', '英雄目录存在重复 ID。', { championId: champion.id });
    champions.set(champion.id, { id: champion.id, name: champion.name });
  }
  return { items, champions };
}

function readCounts(value, field, catalog, allowedKinds) {
  if (!isRecord(value)) fail('INVALID_DRAFT', `${field} 必须是数量字典。`, { field });
  const result = {};
  for (const [id, count] of Object.entries(value)) {
    const item = catalog.items.get(id);
    if (!item) fail('UNKNOWN_ITEM', `${field} 包含未知装备。`, { field, itemId: id });
    if (!allowedKinds.has(item.kind)) fail('INVALID_ITEM_KIND', `${field} 中的装备分类不合法。`, { field, itemId: id, kind: item.kind });
    if (!isCount(count) || count > LIMITS.inventoryCount) fail('INVALID_QUANTITY', `装备数量必须是 0 至 ${LIMITS.inventoryCount} 的整数。`, { field, itemId: id });
    Object.defineProperty(result, id, { value: count, enumerable: true, writable: true, configurable: true });
  }
  return sortedMap(result);
}

function normalizeDraft(draft, catalog) {
  if (!isRecord(draft) || !isCount(draft.version) || !Array.isArray(draft.units)) {
    fail('INVALID_DRAFT', '草案必须包含非负整数 version 和 units 数组。');
  }
  if (draft.units.length > LIMITS.units) fail('DRAFT_LIMIT_EXCEEDED', `草案最多允许 ${LIMITS.units} 个棋子实例。`, { maximum: LIMITS.units });
  const instances = new Set();
  const units = draft.units.map(value => {
    if (!isRecord(value) || typeof value.instanceId !== 'string' || !value.instanceId || typeof value.championId !== 'string'
      || !ROLES.has(value.role) || typeof value.priority !== 'number' || !Number.isFinite(value.priority) || value.priority < 0 || value.priority > LIMITS.priority
      || !Array.isArray(value.lockedItems)) {
      fail('INVALID_UNIT', '棋子实例、职责、优先级或锁定装备不合法。');
    }
    if (instances.has(value.instanceId)) fail('DUPLICATE_INSTANCE', '棋子 instanceId 不能重复。', { instanceId: value.instanceId });
    instances.add(value.instanceId);
    if (!catalog.champions.has(value.championId)) fail('UNKNOWN_CHAMPION', '草案包含未知英雄。', { championId: value.championId });
    if (value.lockedItems.length > 3) fail('SLOT_LIMIT', '棋子装备总共最多占据三槽。', { instanceId: value.instanceId });
    const counts = new Map();
    for (const id of value.lockedItems) {
      const item = catalog.items.get(id);
      if (!item) fail('UNKNOWN_ITEM', '锁定装备包含未知 ID。', { instanceId: value.instanceId, itemId: id });
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (item.unique && counts.get(id) > 1) fail('UNIQUE_CONFLICT', '同一棋子不能重复锁定唯一装备。', { instanceId: value.instanceId, itemId: id });
    }
    const occupiedSlots = value.lockedItems.reduce((sum, id) => sum + catalog.items.get(id).slotCost, 0);
    if (occupiedSlots > 3) fail('SLOT_LIMIT', '锁定装备占用超过三槽。', { instanceId: value.instanceId, occupiedSlots });
    return { instanceId: value.instanceId, championId: value.championId, role: value.role, priority: value.priority, lockedItems: [...value.lockedItems] };
  });
  const components = readCounts(draft.components, 'components', catalog, new Set(['component']));
  const completedItems = readCounts(draft.completedItems, 'completedItems', catalog, new Set(['completed', 'special']));
  const reserve = readCounts(draft.reserve ?? {}, 'reserve', catalog, new Set(['component']));
  for (const [id, count] of Object.entries(reserve)) {
    if (count > countOf(components, id)) fail('RESERVE_EXCEEDS_INVENTORY', '保留散件不能超过实际库存。', { itemId: id, reserved: count, available: countOf(components, id) });
  }
  if (draft.preferences !== undefined && !isRecord(draft.preferences)) fail('INVALID_PREFERENCE', 'preferences 必须是实例到装备 ID 数组的映射。');
  const preferences = {};
  for (const [instanceId, ids] of Object.entries(draft.preferences ?? {})) {
    if (!instances.has(instanceId)) fail('UNKNOWN_INSTANCE', '偏好指向不存在的棋子实例。', { instanceId });
    if (!Array.isArray(ids) || ids.length > LIMITS.preferencesPerUnit || ids.some(id => typeof id !== 'string')) fail('INVALID_PREFERENCE', `偏好必须是最多 ${LIMITS.preferencesPerUnit} 项的装备 ID 数组。`, { instanceId });
    if (new Set(ids).size !== ids.length) fail('INVALID_PREFERENCE', '偏好装备 ID 不能重复。', { instanceId });
    for (const id of ids) {
      const item = catalog.items.get(id);
      if (!item) fail('UNKNOWN_ITEM', '偏好包含未知装备。', { instanceId, itemId: id });
      if (item.kind === 'component') fail('INVALID_PREFERENCE', '规划偏好必须选择成装或特殊装备。', { instanceId, itemId: id });
    }
    Object.defineProperty(preferences, instanceId, { value: [...ids], enumerable: true, writable: true, configurable: true });
  }
  return { version: draft.version, units, components, completedItems, reserve, preferences: sortedMap(preferences) };
}

function prepare(draft, catalog) {
  const normalizedCatalog = normalizeCatalog(catalog);
  const normalizedDraft = normalizeDraft(draft, normalizedCatalog);
  const catalogueConstraints = [...normalizedCatalog.items.values()]
    .map(({ id, name, kind, unique, slotCost, allocationVerified, components, tags, craftable }) => ({ id, name, kind, unique, slotCost, allocationVerified, components, tags, craftable }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const inputHash = hash({ draft: normalizedDraft, items: catalogueConstraints,
    champions: [...normalizedCatalog.champions.keys()].sort(),
    rulesVersion: catalog.rulesVersion ?? catalog.rules_version ?? catalog.context?.rulesVersion ?? null,
    ruleContext: Object.fromEntries(['game', 'set', 'mutator', 'assetVersion'].map(key => [key, catalog.context?.[key] ?? null])) });
  return { draft: normalizedDraft, catalog: normalizedCatalog, inputHash };
}

function rawUtility(unit, item, preferences) {
  const matchedRole = item.tags.some(tag => ROLE_TAGS[unit.role].has(tag));
  const otherRole = !matchedRole && Object.entries(ROLE_TAGS).some(([role, tags]) => role !== unit.role && item.tags.some(tag => tags.has(tag)));
  const list = preferenceList(preferences, unit.instanceId);
  const preferenceIndex = list.indexOf(item.id);
  return 30 + (matchedRole ? 90 : 0) - (otherRole ? 20 : 0)
    + (preferenceIndex >= 0 ? 160 * (list.length - preferenceIndex) / list.length : 0);
}
const hasRoleTag = item => Object.values(ROLE_TAGS).some(tags => item.tags.some(tag => tags.has(tag)));

function makeItem(item, origin) {
  return { itemId: item.id, name: item.name, origin, components: [...item.components], slotCost: item.slotCost };
}

function stateKey(state) {
  // Assignment order is irrelevant; origins remain distinct because their resource costs differ.
  return stable({ assignments: state.assigned.map(items => items.map(item => `${item.origin}:${item.itemId}`).sort()), components: state.components, completed: state.completed });
}

function searchPlan(draft, catalog) {
  const recipeCosts = new Map();
  for (const item of catalog.items.values()) {
    if (!item.craftable) continue;
    const costs = {};
    for (const id of item.components) add(costs, id);
    recipeCosts.set(item.id, Object.entries(costs));
  }
  const equipment = [...catalog.items.values()].filter(item => item.kind !== 'component' && item.allocationVerified
    && (countOf(draft.completedItems, item.id) > 0 || (item.craftable
      && recipeCosts.get(item.id).every(([id, count]) => countOf(draft.components, id) - countOf(draft.reserve, id) >= count))))
    .sort((a, b) => a.id.localeCompare(b.id));
  const priorityLevels = [...new Set(draft.units.map(unit => unit.priority))].sort((a, b) => a - b);
  const weights = draft.units.map(unit => priorityLevels.length < 2 ? 1 : 1 + 2 * priorityLevels.indexOf(unit.priority) / (priorityLevels.length - 1));
  const lockedSlots = draft.units.map(unit => unit.lockedItems.reduce((sum, id) => sum + catalog.items.get(id).slotCost, 0));
  const utility = draft.units.map(unit => new Map(equipment.map(item => [item.id, rawUtility(unit, item, draft.preferences)])));
  const score = (assigned, index) => {
    let slot = lockedSlots[index];
    return assigned.map(item => ({ utility: utility[index].get(item.itemId), slotCost: catalog.items.get(item.itemId).slotCost }))
      .sort((a, b) => b.utility - a.utility).reduce((sum, item) => {
        const weighted = item.utility * SLOT_WEIGHTS[slot] * weights[index];
        slot += item.slotCost;
        return sum + weighted;
      }, 0);
  };
  const start = { assigned: draft.units.map(() => []), components: { ...draft.components }, completed: { ...draft.completedItems }, score: 0, key: '' };
  start.key = stateKey(start);
  let beam = [start];
  let best = start;
  let expansions = 0;
  let budgetReached = false;
  const slots = lockedSlots.reduce((sum, occupied) => sum + 3 - occupied, 0);
  const compare = (a, b) => b.score - a.score || a.key.localeCompare(b.key);
  for (let depth = 0; depth < slots; depth++) {
    const next = new Map();
    for (const state of beam) {
      const moves = [];
      for (let index = 0; index < draft.units.length; index++) {
        const unit = draft.units[index];
        const occupiedSlots = lockedSlots[index] + state.assigned[index].reduce((sum, item) => sum + catalog.items.get(item.itemId).slotCost, 0);
        if (occupiedSlots >= 3) continue;
        const onUnit = [...unit.lockedItems, ...state.assigned[index].map(item => item.itemId)];
        const currentUnitScore = score(state.assigned[index], index);
        for (const item of equipment) {
          if (occupiedSlots + item.slotCost > 3) continue;
          if (item.unique && onUnit.includes(item.id)) continue;
          const origins = [];
          if (countOf(state.completed, item.id) > 0) origins.push('inventory');
          if (item.craftable) {
            if (recipeCosts.get(item.id).every(([id, count]) => countOf(state.components, id) - countOf(draft.reserve, id) >= count)) origins.push('crafted');
          }
          for (const origin of origins) {
            const assigned = [...state.assigned[index], { itemId: item.id, origin }];
            const utilityDelta = score(assigned, index) - currentUnitScore;
            // The tiny tie break preserves flexible components when the same item is in inventory.
            moves.push({ index, item, origin, delta: utilityDelta + (origin === 'inventory' ? 0.001 : 0) });
          }
        }
      }
      moves.sort((a, b) => b.delta - a.delta || draft.units[a.index].instanceId.localeCompare(draft.units[b.index].instanceId)
        || a.item.id.localeCompare(b.item.id) || a.origin.localeCompare(b.origin));
      for (const move of moves.slice(0, SEARCH.movesPerState)) {
        if (expansions >= SEARCH.maxExpansions) { budgetReached = true; break; }
        expansions++;
        const assigned = state.assigned.map((items, index) => index === move.index ? [...items, { itemId: move.item.id, origin: move.origin }] : items);
        const components = { ...state.components };
        const completed = { ...state.completed };
        if (move.origin === 'inventory') completed[move.item.id]--;
        else for (const id of move.item.components) components[id]--;
        const candidate = { assigned, components, completed, score: state.score + move.delta, key: '' };
        candidate.key = stateKey(candidate);
        const previous = next.get(candidate.key);
        if (!previous || compare(candidate, previous) < 0) next.set(candidate.key, candidate);
        if (compare(candidate, best) < 0) best = candidate;
      }
      if (budgetReached) break;
    }
    if (budgetReached || next.size === 0) break;
    beam = [...next.values()].sort(compare).slice(0, SEARCH.beamWidth);
  }
  return { state: best, budgetReached };
}

function explainPreference(unit, item, assignment, remainingComponents, remainingCompletedItems, reserve, items) {
  if (!item.allocationVerified) return '装备穿戴兼容性未核验，已保留库存且不自动分配';
  const occupiedSlots = assignment.items.reduce((sum, equipped) => sum + equipped.slotCost, 0);
  if (occupiedSlots + item.slotCost > 3) return `槽位不足（已占 ${occupiedSlots}/3，目标装备需 ${item.slotCost} 槽）`;
  if (item.unique && assignment.items.some(value => value.itemId === item.id)) return '同一棋子的唯一装备限制';
  if (countOf(remainingCompletedItems, item.id) > 0) return '全队优先级与偏好取舍（启发式搜索）';
  if (!item.craftable) return item.recipeProblem ?? '没有现成库存';
  const needed = {};
  for (const id of item.components) add(needed, id);
  const short = Object.entries(needed).filter(([id, count]) => countOf(remainingComponents, id) - countOf(reserve, id) < count);
  return short.length ? `散件不足或需保留：${short.map(([id]) => items.get(id)?.name ?? id).join('、')}` : '全队优先级与偏好取舍（启发式搜索）';
}

/**
 * Plans a legal team allocation. Higher numeric priority receives greater weight.
 * Locked items never consume bench stock and never move. Items default to one
 * slot; an explicit catalog slotCost (such as three-slot gloves) is enforced.
 * Remaining components
 * include reserves: used + remaining = input, and remaining >= reserve.
 * Special or unverified recipes are never crafted. Existing special inventory
 * requires explicit allocationVerified=true; unverified locked items stay in place.
 */
export function planEquipment(draftInput, catalogInput) {
  const { draft, catalog, inputHash } = prepare(draftInput, catalogInput);
  const { state, budgetReached } = searchPlan(draft, catalog);
  const usedComponents = {};
  const usedCompletedItems = {};
  const assignments = draft.units.map((unit, index) => {
    const locked = unit.lockedItems.map(id => makeItem(catalog.items.get(id), 'locked'));
    const added = state.assigned[index].map(value => makeItem(catalog.items.get(value.itemId), value.origin))
      .sort((a, b) => a.itemId.localeCompare(b.itemId) || a.origin.localeCompare(b.origin));
    for (const item of added) {
      if (item.origin === 'inventory') add(usedCompletedItems, item.itemId);
      else for (const component of item.components) add(usedComponents, component);
    }
    return { instanceId: unit.instanceId, championId: unit.championId, items: [...locked, ...added] };
  });
  const remainingComponents = sortedMap(state.components);
  const remainingCompletedItems = sortedMap(state.completed);
  const warnings = ['本方案依据优先级、职责标签和用户偏好进行确定性启发式分配；没有队伍统计模型，不代表最优胜率。'];
  const ordinaryEquipment = [...catalog.items.values()].filter(item => item.kind === 'completed');
  const missingRoleTags = ordinaryEquipment.filter(item => !hasRoleTag(item));
  if (missingRoleTags.length) warnings.push(missingRoleTags.length === ordinaryEquipment.length
    ? '装备职责标签未核验，当前以优先级与显式偏好分配；未知哈希标签不推断职责。'
    : `装备职责标签存在缺口（${ordinaryEquipment.length} 件普通成装中 ${missingRoleTags.length} 件无可识别属性标签）；这些装备以优先级与显式偏好分配，未知哈希标签不推断职责。`);
  const invalidRecipes = [...catalog.items.values()].filter(item => item.kind === 'completed' && !item.craftable);
  if (invalidRecipes.length) warnings.push(`${invalidRecipes.length} 件成装的配方未验证，已拒绝自动合成：${invalidRecipes.slice(0, 8).map(item => item.name).join('、')}${invalidRecipes.length > 8 ? '等' : ''}。`);
  const unverifiedInventory = Object.entries(draft.completedItems).filter(([id, count]) => count > 0 && !catalog.items.get(id).allocationVerified);
  if (unverifiedInventory.length) warnings.push(`以下库存装备的穿戴兼容性未核验，已保留且不自动分配：${unverifiedInventory.map(([id, count]) => `${catalog.items.get(id).name} × ${count}`).join('、')}。`);
  if (budgetReached) warnings.push('搜索已达到计算预算，返回当前找到的合法方案；部分库存可能未分配。');
  const lines = ['按全队共享库存分配，保留散件不参与合成；锁定装备保留在原棋子且不扣除新库存。'];
  for (const [index, unit] of draft.units.entries()) {
    const assignment = assignments[index];
    const champion = catalog.champions.get(unit.championId);
    lines.push(`${champion.name}（优先级 ${unit.priority}）：${assignment.items.length ? assignment.items.map(item => `${item.name}（${{ locked: '锁定', inventory: '现成库存', crafted: '合成' }[item.origin]}）`).join('、') : '当前资源没有分配到合法装备'}。`);
    for (const id of preferenceList(draft.preferences, unit.instanceId)) {
      if (assignment.items.some(item => item.itemId === id)) continue;
      const item = catalog.items.get(id);
      const message = `${champion.name}未分配偏好装备「${item.name}」：${explainPreference(unit, item, assignment, remainingComponents, remainingCompletedItems, draft.reserve, catalog.items)}。`;
      warnings.push(message);
      lines.push(message);
    }
    if (unit.lockedItems.some(id => catalog.items.get(id).kind === 'component')) warnings.push(`${champion.name}的锁定散件占据槽位，本版保持原样且不使用它合成。`);
    const unverifiedSpecials = unit.lockedItems.map(id => catalog.items.get(id)).filter(item => item.kind === 'special' && !item.allocationVerified);
    if (unverifiedSpecials.length) warnings.push(`${champion.name}的锁定特殊装备「${unverifiedSpecials.map(item => item.name).join('、')}」已按用户输入保留；仅校验资源与槽位，特殊装备穿戴兼容性未核验。`);
  }
  lines.push('这是资源合法的可行方案；偏好与职责匹配仅是排序依据，不能据此声称队伍胜率提升。');
  if (missingRoleTags.length) lines.push('目录职责信息不完整，未识别标签的装备不推断英雄适配；可通过明确装备偏好修正排序。');
  const plan = {
    id: `plan_${inputHash.slice(0, 16)}`, inputHash, draftVersion: draft.version, assignments,
    usedComponents: positive(usedComponents), usedCompletedItems: positive(usedCompletedItems),
    remainingComponents, remainingCompletedItems, reservedComponents: { ...draft.reserve },
    warnings, explanation: lines.join('\n'), feasible: true,
  };
  const validation = validatePlan(plan, draftInput, catalogInput);
  if (!validation.valid) fail('INTERNAL_PLAN_INVALID', '规划器生成的方案未通过资源校验。', { errors: validation.errors });
  return plan;
}

/** Validates the complete draft and catalog without running allocation search. */
export function validateDraft(draftInput, catalogInput) {
  try {
    prepare(draftInput, catalogInput);
    return { valid: true, errors: [] };
  } catch (error) {
    if (!(error instanceof PlannerError)) throw error;
    return { valid: false, errors: [{ code: error.code, message: error.message, details: error.details }] };
  }
}

/** Independently audits a proposed plan and rejects stale or modified resource ledgers. */
export function validatePlan(plan, draftInput, catalogInput) {
  const errors = [];
  const issue = (code, message, details = {}) => errors.push({ code, message, details });
  let prepared;
  try { prepared = prepare(draftInput, catalogInput); }
  catch (error) {
    if (!(error instanceof PlannerError)) throw error;
    return { valid: false, errors: [{ code: error.code, message: error.message, details: error.details }] };
  }
  const { draft, catalog, inputHash } = prepared;
  if (!isRecord(plan)) return { valid: false, errors: [{ code: 'INVALID_PLAN', message: '方案必须是对象。', details: {} }] };
  if (plan.inputHash !== inputHash || plan.draftVersion !== draft.version) issue('STALE_PLAN', '草案、版本或目录已变化，方案不可直接应用。');
  if (plan.id !== `plan_${inputHash.slice(0, 16)}`) issue('INVALID_PLAN_ID', '方案 ID 与输入不一致。');
  if (plan.feasible !== true) issue('INVALID_PLAN', '方案未声明资源可行。');
  if (!Array.isArray(plan.warnings) || plan.warnings.some(value => typeof value !== 'string') || typeof plan.explanation !== 'string') issue('INVALID_PLAN', '方案缺少合法的解释或警告。');
  if (!Array.isArray(plan.assignments)) return { valid: false, errors: [...errors, { code: 'INVALID_ASSIGNMENTS', message: '分配必须是数组。', details: {} }] };
  const expectedUnits = new Map(draft.units.map(unit => [unit.instanceId, unit]));
  const seen = new Set();
  const computedComponents = {};
  const computedCompleted = {};
  for (const assignment of plan.assignments) {
    if (!isRecord(assignment) || typeof assignment.instanceId !== 'string' || !Array.isArray(assignment.items)) { issue('INVALID_ASSIGNMENT', '棋子分配格式不合法。'); continue; }
    const unit = expectedUnits.get(assignment.instanceId);
    if (!unit) { issue('UNKNOWN_INSTANCE', '方案包含草案以外的棋子。', { instanceId: assignment.instanceId }); continue; }
    if (seen.has(unit.instanceId)) issue('DUPLICATE_INSTANCE', '方案重复分配同一棋子。', { instanceId: unit.instanceId });
    seen.add(unit.instanceId);
    if (assignment.championId !== unit.championId) issue('CHAMPION_MISMATCH', '棋子英雄与草案不一致。', { instanceId: unit.instanceId });
    if (assignment.items.length > 3) issue('SLOT_LIMIT', '方案超过三槽。', { instanceId: unit.instanceId });
    const lockedIds = [];
    const equipmentCounts = new Map();
    let occupiedSlots = 0;
    for (const value of assignment.items) {
      if (!isRecord(value) || typeof value.itemId !== 'string' || !ORIGINS.has(value.origin)) { issue('INVALID_ASSIGNMENT_ITEM', '装备分配格式或来源不合法。', { instanceId: unit.instanceId }); continue; }
      const item = catalog.items.get(value.itemId);
      if (!item) { issue('UNKNOWN_ITEM', '方案包含未知装备。', { itemId: value.itemId }); continue; }
      occupiedSlots += item.slotCost;
      if (value.slotCost !== undefined && value.slotCost !== item.slotCost) issue('SLOT_COST_MISMATCH', '装备占用槽数与目录不一致。', { itemId: item.id });
      if (value.name !== item.name) issue('ITEM_NAME_MISMATCH', '装备名称与目录不一致。', { itemId: item.id });
      if (!Array.isArray(value.components) || value.components.some(id => typeof id !== 'string') || !sameBag(value.components, item.components)) {
        issue('RECIPE_MISMATCH', '装备的组成与目录不一致。', { itemId: item.id });
      }
      equipmentCounts.set(item.id, (equipmentCounts.get(item.id) ?? 0) + 1);
      if (item.unique && equipmentCounts.get(item.id) > 1) issue('UNIQUE_CONFLICT', '同一棋子重复装备唯一物品。', { instanceId: unit.instanceId, itemId: item.id });
      if (value.origin === 'locked') lockedIds.push(item.id);
      else if (value.origin === 'inventory') {
        if (item.kind === 'component') issue('INVALID_ITEM_KIND', '散件不能作为成装库存分配。', { itemId: item.id });
        if (!item.allocationVerified) issue('UNVERIFIED_ALLOCATION', '库存装备穿戴兼容性未核验，禁止自动分配。', { itemId: item.id });
        add(computedCompleted, item.id);
      } else {
        if (!item.allocationVerified) issue('UNVERIFIED_ALLOCATION', '装备穿戴兼容性未核验，禁止自动分配。', { itemId: item.id });
        if (!item.craftable) issue('UNSUPPORTED_RECIPE', '未验证或特殊配方禁止合成。', { itemId: item.id });
        else for (const id of item.components) add(computedComponents, id);
      }
    }
    if (occupiedSlots > 3) issue('SLOT_LIMIT', '装备占用总槽数超过三槽。', { instanceId: unit.instanceId, occupiedSlots });
    if (!sameBag(lockedIds, unit.lockedItems)) issue('LOCKED_ITEMS_CHANGED', '锁定装备被拆卸、移动或新增。', { instanceId: unit.instanceId });
  }
  for (const id of expectedUnits.keys()) if (!seen.has(id)) issue('MISSING_INSTANCE', '方案遗漏棋子实例。', { instanceId: id });
  const expectedRemainingComponents = { ...draft.components };
  const expectedRemainingCompleted = { ...draft.completedItems };
  for (const [id, count] of Object.entries(computedComponents)) {
    add(expectedRemainingComponents, id, -count);
    if (countOf(expectedRemainingComponents, id) < countOf(draft.reserve, id)) issue('COMPONENT_OVERSPEND', '散件被重复使用或动用了保留库存。', { itemId: id });
  }
  for (const [id, count] of Object.entries(computedCompleted)) {
    add(expectedRemainingCompleted, id, -count);
    if (expectedRemainingCompleted[id] < 0) issue('COMPLETED_ITEM_OVERSPEND', '成装库存被重复使用。', { itemId: id });
  }
  const checkLedger = (field, expected, allowedKinds) => {
    const actual = plan[field];
    if (!isRecord(actual)) { issue('INVALID_LEDGER', '库存账本必须是数量字典。', { field }); return; }
    for (const [id, count] of Object.entries(actual)) {
      if (!isCount(count) || !allowedKinds.has(catalog.items.get(id)?.kind)) issue('INVALID_LEDGER', '库存账本包含未知装备或非法数量。', { field, itemId: id });
    }
    for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (countOf(actual, id) !== countOf(expected, id)) issue('LEDGER_MISMATCH', '库存账本与实际分配不一致。', { field, itemId: id, expected: countOf(expected, id), actual: countOf(actual, id) });
    }
  };
  const componentKinds = new Set(['component']);
  const completedKinds = new Set(['completed', 'special']);
  checkLedger('usedComponents', computedComponents, componentKinds);
  checkLedger('usedCompletedItems', computedCompleted, completedKinds);
  checkLedger('remainingComponents', expectedRemainingComponents, componentKinds);
  checkLedger('remainingCompletedItems', expectedRemainingCompleted, completedKinds);
  checkLedger('reservedComponents', draft.reserve, componentKinds);
  return { valid: errors.length === 0, errors };
}
