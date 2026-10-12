import test from 'node:test';
import assert from 'node:assert/strict';
import { planEquipment, validatePlan, validateDraft, PlannerError } from '../server/planner.mjs';

const catalog = {
  rulesVersion: 'test-1',
  champions: [{ id: 'c', name: '输出英雄' }, { id: 't', name: '坦克英雄' }, { id: 's', name: '辅助英雄' }],
  items: [
    { id: 'sword', name: '大剑', kind: 'component', components: [], unique: false },
    { id: 'belt', name: '腰带', kind: 'component', components: [], unique: false },
    { id: 'rod', name: '大棒', kind: 'component', components: [], unique: false },
    { id: 'attack', name: '双剑', kind: 'completed', components: ['sword', 'sword'], unique: false, tags: ['carry'] },
    { id: 'armor', name: '双腰带', kind: 'completed', components: ['belt', 'belt'], unique: true, tags: ['tank'] },
    { id: 'magic', name: '双大棒', kind: 'completed', components: ['rod', 'rod'], unique: true, tags: ['carry'] },
    { id: 'mixed', name: '大剑腰带', kind: 'completed', components: ['sword', 'belt'], unique: false, tags: ['support'] },
    { id: 'spell', name: '大剑大棒', kind: 'completed', components: ['sword', 'rod'], unique: true, tags: ['carry'] },
    { id: 'support', name: '腰带大棒', kind: 'completed', components: ['belt', 'rod'], unique: true, tags: ['support'] },
    { id: 'gloves', name: '三槽手套', kind: 'completed', components: ['rod', 'belt'], unique: true, slotCost: 3, tags: ['carry'] },
    { id: 'radiantGloves', name: '特殊三槽手套', kind: 'special', components: [], unique: true, slotCost: 3, allocationVerified: true, tags: ['carry'] },
    { id: 'special', name: '特殊装备', kind: 'special', components: ['sword', 'rod'], unique: true, allocationVerified: true, tags: ['carry'] },
    { id: 'unverified', name: '未验证配方', kind: 'completed', components: ['sword', 'unknown'], unique: true },
  ],
};

const unit = (instanceId, championId = 'c', role = 'carry', priority = 1, lockedItems = []) => ({ instanceId, championId, role, priority, lockedItems });
const draft = overrides => ({ version: 1, units: [unit('u1')], components: {}, completedItems: {}, reserve: {}, ...overrides });
const clone = value => structuredClone(value);
const newItems = plan => plan.assignments.flatMap(assignment => assignment.items.filter(item => item.origin !== 'locked'));
const errorCode = code => error => error instanceof PlannerError && error.code === code;

test('locked items use slots without consuming bench inventory; reserves remain in physical stock', () => {
  const input = draft({
    units: [unit('u1', 'c', 'carry', 3, ['spell', 'attack']), unit('u2', 't', 'tank', 2, ['armor'])],
    components: { sword: 3, belt: 3, rod: 1 }, reserve: { sword: 1, belt: 1 },
    completedItems: { attack: 1 }, preferences: { u1: ['attack'], u2: ['armor'] },
  });
  const before = clone(input);
  const plan = planEquipment(input, catalog);
  assert.deepEqual(input, before, 'caller draft must not be mutated');
  assert.equal(validatePlan(plan, input, catalog).valid, true);
  assert.deepEqual(plan.assignments[0].items.slice(0, 2).map(item => [item.itemId, item.origin]), [['spell', 'locked'], ['attack', 'locked']]);
  assert.equal(plan.assignments[0].items.length, 3);
  assert.equal(plan.usedCompletedItems.attack, 1);
  assert.equal(plan.remainingComponents.sword >= 1, true);
  assert.equal(plan.remainingComponents.belt >= 1, true);
  assert.equal(plan.assignments[1].items.filter(item => item.itemId === 'armor').length, 1, 'unique locked item is never duplicated');
});

test('team search resolves a recipe conflict by keeping a two-item allocation', () => {
  const small = {
    champions: catalog.champions,
    items: [...catalog.items.filter(item => item.kind === 'component'),
      { id: 'A', name: '争用大剑', kind: 'completed', components: ['sword', 'rod'], unique: true, tags: ['carry'] },
      { id: 'B', name: '辅助装备', kind: 'completed', components: ['sword', 'belt'], unique: true, tags: ['support'] },
      { id: 'C', name: '坦克装备', kind: 'completed', components: ['rod', 'rod'], unique: true, tags: ['tank'] }],
  };
  const input = draft({ units: [unit('carry'), unit('support', 's', 'support'), unit('tank', 't', 'tank')],
    components: { sword: 1, rod: 2, belt: 1 }, preferences: { carry: ['A'], support: ['B'], tank: ['C'] } });
  const plan = planEquipment(input, small);
  assert.deepEqual(newItems(plan).map(item => item.itemId).sort(), ['B', 'C']);
  assert.deepEqual(plan.assignments.find(value => value.instanceId === 'support').items.map(item => item.itemId), ['B']);
  assert.deepEqual(plan.assignments.find(value => value.instanceId === 'tank').items.map(item => item.itemId), ['C']);
  assert.equal(plan.remainingComponents.sword + plan.remainingComponents.rod + plan.remainingComponents.belt, 0);
  assert.equal(plan.warnings.some(warning => warning.includes('未分配偏好装备')), true);
});

test('higher priority wins a same-role inventory conflict and output is deterministic', () => {
  const input = draft({ units: [unit('low', 'c', 'carry', 1), unit('high', 'c', 'carry', 9)], completedItems: { spell: 1 } });
  const plan = planEquipment(input, catalog);
  assert.deepEqual(plan.assignments.find(value => value.instanceId === 'high').items.map(item => item.itemId), ['spell']);
  assert.deepEqual(planEquipment(input, catalog), plan);
  assert.equal(plan.explanation.includes('不代表最优胜率') || plan.warnings.some(warning => warning.includes('不代表最优胜率')), true);
});

test('source attribute tags inform role scoring while unknown hashed labels remain explicitly unverified', () => {
  const known = { champions: catalog.champions, items: [
    ...catalog.items.filter(item => item.kind === 'component'),
    { id: 'damage', name: '输出装备', kind: 'completed', components: ['sword', 'sword'], unique: true, tags: ['AttackDamage'] },
    { id: 'defense', name: '防御装备', kind: 'completed', components: ['belt', 'belt'], unique: true, tags: ['Armor'] },
  ] };
  const input = draft({ units: [unit('carry'), unit('tank', 't', 'tank')], completedItems: { damage: 1, defense: 1 } });
  const plan = planEquipment(input, known);
  assert.deepEqual(plan.assignments[0].items.map(item => item.itemId), ['damage']);
  assert.deepEqual(plan.assignments[1].items.map(item => item.itemId), ['defense']);
  const unknown = clone(known);
  unknown.items.filter(item => item.kind === 'completed').forEach(item => { item.tags = ['{7ea41d13}']; });
  const fallback = planEquipment(input, unknown);
  assert.ok(fallback.warnings.some(message => message.includes('装备职责标签未核验，当前以优先级与显式偏好分配')));
});

test('inventory is preferred over crafting the same item in a single free slot', () => {
  const input = draft({ units: [unit('u1', 'c', 'carry', 1, ['attack', 'spell'])],
    components: { rod: 2 }, completedItems: { magic: 1 }, preferences: { u1: ['magic'] } });
  const plan = planEquipment(input, catalog);
  assert.equal(plan.assignments[0].items[2].origin, 'inventory');
  assert.deepEqual(plan.usedComponents, {});
  assert.equal(plan.remainingComponents.rod, 2);
});

test('unique is per instance; repeated champion instances may each hold one unique item', () => {
  const input = draft({ units: [unit('copy1', 't', 'tank'), unit('copy2', 't', 'tank')], completedItems: { armor: 2 } });
  const plan = planEquipment(input, catalog);
  assert.equal(plan.assignments.every(value => value.items.filter(item => item.itemId === 'armor').length === 1), true);
  assert.equal(plan.usedCompletedItems.armor, 2);
});

test('same-component recipes require two copies and a reserved copy cannot be spent', () => {
  const input = draft({ components: { sword: 2 }, reserve: { sword: 1 }, preferences: { u1: ['attack'] } });
  const plan = planEquipment(input, catalog);
  assert.equal(newItems(plan).length, 0);
  assert.equal(plan.remainingComponents.sword, 2);
  assert.deepEqual(plan.usedComponents, {});
  assert.equal(plan.warnings.some(value => value.includes('散件不足或需保留：大剑')), true);
  assert.equal(plan.explanation.includes('散件不足或需保留：大剑'), true);
  assert.equal(plan.explanation.includes('散件不足或需保留：sword'), false);
});

test('special and unknown recipes are refused without guessing, but existing specials remain usable', () => {
  const input = draft({ components: { sword: 1, rod: 1 }, preferences: { u1: ['special', 'unverified'] } });
  const plan = planEquipment(input, catalog);
  assert.equal(newItems(plan).some(item => ['special', 'unverified'].includes(item.itemId)), false);
  assert.equal(plan.warnings.some(value => value.includes('特殊装备不参与自动合成')), true);
  assert.equal(plan.warnings.some(value => value.includes('配方未验证')), true);
  const inventory = planEquipment(draft({ completedItems: { special: 1 }, preferences: { u1: ['special'] } }), catalog);
  assert.deepEqual(newItems(inventory).map(item => [item.itemId, item.origin]), [['special', 'inventory']]);
  const forged = clone(plan);
  forged.assignments[0].items = [{ itemId: 'special', name: '特殊装备', origin: 'crafted', components: ['sword', 'rod'] }];
  assert.equal(validatePlan(forged, input, catalog).errors.some(value => value.code === 'UNSUPPORTED_RECIPE'), true);
  const explicitlyUnverified = clone(catalog);
  explicitlyUnverified.items.find(item => item.id === 'attack').recipeVerified = false;
  const withheld = planEquipment(draft({ components: { sword: 2 }, preferences: { u1: ['attack'] } }), explicitlyUnverified);
  assert.equal(newItems(withheld).length, 0);
  assert.equal(withheld.warnings.some(value => value.includes('配方未验证')), true);
});

test('locked component stays intact and never contributes crafting resources', () => {
  const input = draft({ units: [unit('u1', 'c', 'carry', 1, ['sword'])], components: { sword: 1 }, preferences: { u1: ['attack'] } });
  const plan = planEquipment(input, catalog);
  assert.deepEqual(plan.assignments[0].items.map(item => [item.itemId, item.origin]), [['sword', 'locked']]);
  assert.equal(plan.remainingComponents.sword, 1);
});

test('unverified special inventory remains untouched and forged automatic allocation is independently rejected', () => {
  const unknownCompatibility = clone(catalog);
  delete unknownCompatibility.items.find(item => item.id === 'special').allocationVerified;
  unknownCompatibility.items.find(item => item.id === 'radiantGloves').allocationVerified = false;
  const input = draft({ completedItems: { special: 2, radiantGloves: 1 }, preferences: { u1: ['special', 'radiantGloves'] } });
  const plan = planEquipment(input, unknownCompatibility);
  assert.deepEqual(newItems(plan), []);
  assert.deepEqual(plan.usedCompletedItems, {});
  assert.deepEqual(plan.remainingCompletedItems, input.completedItems);
  assert.ok(plan.warnings.some(message => message.includes('特殊装备 × 2') && message.includes('兼容性未核验')));
  assert.ok(plan.warnings.some(message => message.includes('特殊三槽手套 × 1') && message.includes('不自动分配')));
  const forged = clone(plan);
  forged.assignments[0].items = [{ itemId: 'special', name: '特殊装备', origin: 'inventory', components: ['sword', 'rod'], slotCost: 1 }];
  forged.usedCompletedItems.special = 1;
  forged.remainingCompletedItems.special = 1;
  const audit = validatePlan(forged, input, unknownCompatibility);
  assert.equal(audit.valid, false);
  assert.ok(audit.errors.some(error => error.code === 'UNVERIFIED_ALLOCATION'));
  assert.equal(audit.errors.some(error => error.code === 'LEDGER_MISMATCH'), false, 'compatibility rejection does not rely on a resource mismatch');
  assert.ok(validatePlan(plan, input, catalog).errors.some(error => error.code === 'STALE_PLAN'), 'compatibility verification is bound to the input hash');
});

test('user-locked special items are preserved with an explicit compatibility boundary warning', () => {
  const unknownCompatibility = clone(catalog);
  unknownCompatibility.items.find(item => item.id === 'special').allocationVerified = false;
  const input = draft({ units: [unit('u1', 'c', 'carry', 1, ['special'])] });
  const plan = planEquipment(input, unknownCompatibility);
  assert.deepEqual(plan.assignments[0].items.map(item => [item.itemId, item.origin]), [['special', 'locked']]);
  assert.equal(validatePlan(plan, input, unknownCompatibility).valid, true);
  assert.ok(plan.warnings.some(message => message.includes('仅校验资源与槽位') && message.includes('特殊装备穿戴兼容性未核验')));
});

test('three-slot equipment fills all slots and cannot join an existing ordinary item', () => {
  const blocked = draft({ units: [unit('u1', 'c', 'carry', 1, ['attack'])],
    components: { rod: 1, belt: 1 }, completedItems: { gloves: 1, radiantGloves: 1 }, preferences: { u1: ['gloves', 'radiantGloves'] } });
  const blockedPlan = planEquipment(blocked, catalog);
  assert.equal(blockedPlan.assignments[0].items.some(item => ['gloves', 'radiantGloves'].includes(item.itemId)), false);
  assert.equal(blockedPlan.warnings.some(message => message.includes('目标装备需 3 槽')), true);
  const locked = draft({ units: [unit('u1', 'c', 'carry', 1, ['gloves'])],
    components: { sword: 4 }, completedItems: { attack: 2, armor: 1 }, preferences: { u1: ['attack'] } });
  const lockedPlan = planEquipment(locked, catalog);
  assert.equal(lockedPlan.assignments[0].items.length, 1);
  assert.equal(lockedPlan.assignments[0].items[0].slotCost, 3);
  assert.deepEqual(lockedPlan.usedComponents, {});
  assert.deepEqual(lockedPlan.usedCompletedItems, {});
  assert.throws(() => planEquipment(draft({ units: [unit('u1', 'c', 'carry', 1, ['gloves', 'attack'])] }), catalog), errorCode('SLOT_LIMIT'));
  const forged = clone(lockedPlan);
  forged.assignments[0].items.push({ itemId: 'attack', name: '双剑', origin: 'inventory', components: ['sword', 'sword'], slotCost: 1 });
  assert.ok(validatePlan(forged, locked, catalog).errors.some(error => error.code === 'SLOT_LIMIT'));
  // Removing the display field cannot bypass the authoritative catalog cost.
  delete forged.assignments[0].items[0].slotCost;
  assert.ok(validatePlan(forged, locked, catalog).errors.some(error => error.code === 'SLOT_LIMIT'));
});

test('three-slot inventory and crafted items can be chosen alone; slot cost changes invalidate a plan', () => {
  for (const input of [draft({ completedItems: { gloves: 1, attack: 1 }, preferences: { u1: ['gloves'] } }),
    draft({ components: { rod: 1, belt: 1 }, preferences: { u1: ['gloves'] } }),
    draft({ completedItems: { radiantGloves: 1, attack: 1 }, preferences: { u1: ['radiantGloves'] } })]) {
    const plan = planEquipment(input, catalog);
    assert.equal(plan.assignments[0].items.length, 1);
    assert.equal(plan.assignments[0].items[0].slotCost, 3);
    assert.equal(validatePlan(plan, input, catalog).valid, true);
    const changed = clone(catalog);
    changed.items.find(item => item.id === plan.assignments[0].items[0].itemId).slotCost = 1;
    assert.ok(validatePlan(plan, input, changed).errors.some(error => error.code === 'STALE_PLAN'));
  }
});

test('empty board is a valid plan and full slots do not consume inventory', () => {
  const empty = draft({ units: [], components: { sword: 4 }, completedItems: { magic: 1 } });
  assert.deepEqual(planEquipment(empty, catalog).assignments, []);
  const full = draft({ units: [unit('u1', 'c', 'carry', 1, ['attack', 'spell', 'magic'])], components: { sword: 4 }, completedItems: { magic: 1 } });
  const plan = planEquipment(full, catalog);
  assert.deepEqual(plan.usedComponents, {});
  assert.deepEqual(plan.usedCompletedItems, {});
});

test('input and recipe changes invalidate the hash even when resources still look legal', () => {
  const input = draft({ components: { sword: 2 } });
  const plan = planEquipment(input, catalog);
  for (const changed of [draft({ components: { sword: 2 }, version: 2 }), draft({ components: { sword: 3 } }), draft({ components: { sword: 2 }, reserve: { sword: 1 } }), draft({ components: { sword: 2 }, preferences: { u1: ['spell'] } })]) {
    assert.equal(validatePlan(plan, changed, catalog).errors.some(error => error.code === 'STALE_PLAN'), true);
  }
  const changedCatalog = clone(catalog);
  changedCatalog.items.find(item => item.id === 'attack').unique = true;
  assert.equal(validatePlan(plan, input, changedCatalog).errors.some(error => error.code === 'STALE_PLAN'), true);
  const newRuleContext = { ...catalog, context: { set: 18, assetVersion: '16.20', rulesVersion: 'hotfix-v2' } };
  assert.equal(validatePlan(plan, input, newRuleContext).errors.some(error => error.code === 'STALE_PLAN'), true);
});

test('independent validator detects overspending, tampered ledgers, locks, names, slots and duplicate instances', () => {
  const input = draft({ units: [unit('u1', 'c', 'carry', 1, ['spell'])], components: { sword: 2 }, completedItems: { armor: 1 } });
  const plan = planEquipment(input, catalog);
  const mutations = [
    [value => { value.usedComponents = {}; }, 'LEDGER_MISMATCH'],
    [value => { value.remainingComponents.sword = 100; }, 'LEDGER_MISMATCH'],
    [value => { value.assignments[0].items = value.assignments[0].items.filter(item => item.origin !== 'locked'); }, 'LOCKED_ITEMS_CHANGED'],
    [value => { value.assignments[0].items[0].name = '伪造名字'; }, 'ITEM_NAME_MISMATCH'],
    [value => { value.assignments.push(clone(value.assignments[0])); }, 'DUPLICATE_INSTANCE'],
    [value => { value.assignments[0].items.push({ itemId: 'attack', name: '双剑', origin: 'crafted', components: ['sword', 'sword'] }); }, 'COMPONENT_OVERSPEND'],
    [value => { value.assignments[0].items.push({ itemId: 'armor', name: '双腰带', origin: 'inventory', components: ['belt', 'belt'] }); }, 'SLOT_LIMIT'],
  ];
  for (const [mutation, expected] of mutations) {
    const changed = clone(plan);
    mutation(changed);
    const result = validatePlan(changed, input, catalog);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some(error => error.code === expected), true, `${expected}: ${JSON.stringify(result.errors)}`);
  }
});

test('invalid draft quantities, IDs, locks and preferences return typed errors', () => {
  const cases = [
    [draft({ version: -1 }), 'INVALID_DRAFT'],
    [draft({ components: { sword: -1 } }), 'INVALID_QUANTITY'],
    [draft({ components: { sword: 1.5 } }), 'INVALID_QUANTITY'],
    [draft({ components: { sword: 100 } }), 'INVALID_QUANTITY'],
    [draft({ completedItems: { attack: 100 } }), 'INVALID_QUANTITY'],
    [draft({ units: Array.from({ length: 33 }, (_, index) => unit(`u${index}`)) }), 'DRAFT_LIMIT_EXCEEDED'],
    [draft({ units: [unit('x', 'c', 'carry', 1001)] }), 'INVALID_UNIT'],
    [draft({ completedItems: { sword: 1 } }), 'INVALID_ITEM_KIND'],
    [draft({ components: { missing: 1 } }), 'UNKNOWN_ITEM'],
    [draft({ units: [unit('x', 'unknown')] }), 'UNKNOWN_CHAMPION'],
    [draft({ units: [unit('x'), unit('x')] }), 'DUPLICATE_INSTANCE'],
    [draft({ units: [unit('x', 'c', 'carry', 1, ['attack', 'attack', 'attack', 'attack'])] }), 'SLOT_LIMIT'],
    [draft({ units: [unit('x', 'c', 'carry', 1, ['spell', 'spell'])] }), 'UNIQUE_CONFLICT'],
    [draft({ reserve: { sword: 1 } }), 'RESERVE_EXCEEDS_INVENTORY'],
    [draft({ preferences: { missing: ['spell'] } }), 'UNKNOWN_INSTANCE'],
    [draft({ preferences: { u1: ['sword'] } }), 'INVALID_PREFERENCE'],
  ];
  for (const [input, code] of cases) assert.throws(() => planEquipment(input, catalog), errorCode(code));
  for (const [input, code] of cases) {
    const validation = validateDraft(input, catalog);
    assert.equal(validation.valid, false);
    assert.equal(validation.errors[0].code, code);
  }
  assert.deepEqual(validateDraft(draft(), catalog), { valid: true, errors: [] });
  assert.equal(validatePlan({}, draft({ components: { sword: -1 } }), catalog).valid, false);
});

test('data IDs that match object prototype keys remain ordinary inventory keys', () => {
  const unusual = {
    champions: [{ id: 'c', name: '英雄' }],
    items: [
      { id: '__proto__', name: '散件一', kind: 'component', components: [], unique: false },
      { id: 'toString', name: '散件二', kind: 'component', components: [], unique: false },
      { id: 'constructor', name: '合成装备', kind: 'completed', components: ['__proto__', 'toString'], unique: true },
    ],
  };
  const input = draft({ units: [unit('toString')], components: Object.fromEntries([['__proto__', 1], ['toString', 1]]),
    preferences: Object.fromEntries([['toString', ['constructor']]]) });
  const plan = planEquipment(input, unusual);
  assert.equal(newItems(plan)[0].itemId, 'constructor');
  assert.equal(plan.usedComponents.__proto__, 1);
  assert.equal(plan.usedComponents.toString, 1);
  assert.equal(plan.remainingComponents.__proto__, 0);
  assert.equal(validatePlan(plan, input, unusual).valid, true);
});

test('random boards and multiple inventories conserve independently counted resources and satisfy item invariants', () => {
  // Seeded generation makes failures reproducible. This audits physical resources,
  // not the planner's ranking or search implementation.
  let seed = 0x154f41;
  const next = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  const recipes = { attack: ['sword', 'sword'], armor: ['belt', 'belt'], magic: ['rod', 'rod'], mixed: ['sword', 'belt'], spell: ['sword', 'rod'], support: ['belt', 'rod'], gloves: ['rod', 'belt'] };
  const uniqueItems = new Set(['armor', 'magic', 'spell', 'support', 'special', 'unverified', 'gloves', 'radiantGloves']);
  for (let iteration = 0; iteration < 80; iteration++) {
    const units = Array.from({ length: 1 + next(4) }, (_, index) => {
      const role = ['carry', 'tank', 'support'][next(3)];
      const locked = next(3) === 0 ? [['attack'], ['armor'], ['sword'], ['spell', 'attack'], ['gloves']][next(5)] : [];
      return unit(`u${index}`, { carry: 'c', tank: 't', support: 's' }[role], role, next(5), locked);
    });
    const components = { sword: next(5), belt: next(5), rod: next(5) };
    const completedItems = { attack: next(3), armor: next(3), magic: next(2), special: next(2), gloves: next(2), radiantGloves: next(2) };
    const reserve = Object.fromEntries(Object.entries(components).map(([id, count]) => [id, next(count + 1)]));
    const preferences = Object.fromEntries(units.map(value => [value.instanceId, [Object.keys(recipes)[next(Object.keys(recipes).length)]]]));
    const input = draft({ version: iteration, units, components, completedItems, reserve, preferences });
    const plan = planEquipment(input, catalog);
    const spent = { sword: 0, belt: 0, rod: 0 };
    const taken = { attack: 0, armor: 0, magic: 0, special: 0, gloves: 0, radiantGloves: 0 };
    assert.equal(plan.assignments.length, units.length);
    for (const assignment of plan.assignments) {
      const source = units.find(value => value.instanceId === assignment.instanceId);
      assert.ok(assignment.items.length <= 3);
      assert.ok(assignment.items.reduce((sum, item) => sum + (['gloves', 'radiantGloves'].includes(item.itemId) ? 3 : 1), 0) <= 3);
      assert.deepEqual(assignment.items.filter(item => item.origin === 'locked').map(item => item.itemId), source.lockedItems);
      const ids = assignment.items.map(item => item.itemId);
      for (const id of uniqueItems) assert.ok(ids.filter(value => value === id).length <= 1);
      for (const item of assignment.items) {
        if (item.origin === 'crafted') {
          assert.ok(Object.hasOwn(recipes, item.itemId), 'only known ordinary recipes are crafted');
          for (const component of recipes[item.itemId]) spent[component]++;
        }
        if (item.origin === 'inventory') taken[item.itemId]++;
      }
    }
    for (const id of ['sword', 'belt', 'rod']) {
      assert.equal((plan.usedComponents[id] ?? 0), spent[id]);
      assert.equal(spent[id] + plan.remainingComponents[id], components[id]);
      assert.ok(plan.remainingComponents[id] >= reserve[id]);
    }
    for (const [id, count] of Object.entries(completedItems)) {
      assert.equal((plan.usedCompletedItems[id] ?? 0), taken[id]);
      assert.equal(taken[id] + plan.remainingCompletedItems[id], count);
    }
    assert.equal(validatePlan(plan, input, catalog).valid, true, `seeded board ${iteration}`);
  }
});
