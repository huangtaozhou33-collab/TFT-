import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLineup, computeLineupTraits, computeLineupPopulation, createLineupFromDeck, lineupContextKey } from '../public/lineup-model.js';
import { getCatalog } from '../server/data.mjs';

const context = { game: 'tft', set: 18, mutator: 'TFTSet18', assetVersion: '16.20', rulesVersion: 'test' };
const catalog = { context, champions: [{id:'a',name:'甲',traits:['守卫']},{id:'b',name:'乙',traits:['法师']}],
  items: [{id:'emblem',category:'emblem',traitId:'guard',unique:true},{id:'gloves',slotCost:3},{id:'sword',slotCost:1}],
  traits: [{id:'guard',name:'守卫',effects:[{minUnits:2},{minUnits:4}]},{id:'mage',name:'法师',effects:[{minUnits:2}]}] };
const unit = (instanceId,championId,cell=null,items=[]) => ({instanceId,championId,cell,items,star:1});
const plan = units => ({schemaVersion:2,context,title:'个人阵容',notes:'',units});

test('lineup validates PC context, current entities and non-overlapping integer hexes', () => {
  assert.equal(validateLineup(plan([unit('1','a',{x:7,y:4}),unit('2','b')]),catalog).valid,true);
  for (const [input,code] of [
    [{...plan([]),context:{...context,game:'jcc'}},'PC_TFT_ONLY'],
    [{...plan([]),context:{...context,set:17}},'LINEUP_VERSION_MISMATCH'],
    [plan([unit('1','unknown')]),'UNKNOWN_CHAMPION'],
    [plan([unit('1','a',{x:0,y:1})]),'INVALID_CELL'],
    [plan([unit('1','a',{x:1.5,y:1})]),'INVALID_CELL'],
    [plan([unit('1','a',{x:1,y:1}),unit('2','b',{x:1,y:1})]),'CELL_OCCUPIED'],
    [plan([unit('1','a'),unit('1','b')]),'INVALID_INSTANCE']
  ]) assert.ok(validateLineup(input,catalog).errors.some(error=>error.code===code),code);
  assert.equal(validateLineup(plan([unit('1','a')]),catalog,{allowUnplaced:false}).valid,false);
  assert.equal(lineupContextKey({...context,fetchedAt:'tomorrow'}),lineupContextKey(context));
});

test('multi-slot and unique items reject invalid plans without mutating input', () => {
  const input = plan([unit('1','a',null,['gloves','sword'])]);
  const original=structuredClone(input);
  assert.ok(validateLineup(input,catalog).errors.some(error=>error.code==='ITEM_SLOT_LIMIT'));
  assert.deepEqual(input,original);
  assert.equal(validateLineup(plan([unit('1','a',null,['gloves'])]),catalog).valid,true);
  assert.ok(validateLineup(plan([unit('1','a',null,['emblem','emblem'])]),catalog).errors.some(error=>error.code==='UNIQUE_ITEM'));
  assert.equal(validateLineup(plan([unit('1','a',null,['sword','sword','sword'])]),catalog).valid,true);
});

test('planning traits count distinct champions and exact emblems including unplaced units', () => {
  const units=[unit('1','a'),unit('2','a',null,['emblem']),unit('3','b',null,['emblem'])];
  const guard=computeLineupTraits(units,catalog).find(trait=>trait.id==='guard');
  assert.equal(guard.count,2);
  assert.deepEqual(guard.contributions,{native:1,emblem:1});
  assert.equal(guard.activeThreshold,2);
  assert.equal(guard.nextThreshold,4);
  assert.equal(guard.active,true);
  assert.equal(computeLineupTraits([unit('1','b')],catalog).find(trait=>trait.id==='mage').active,false);
});

test('source draft preserves missing coordinates, marks unknown stars and isolates source record', () => {
  const source={id:'source',name:'来源阵容',units:[{id:'a',items:['sword'],cell:null}],stats:{sampleSize:150,winRate:.2},evidence:{recordHash:'real'}};
  const original=structuredClone(source), draft=createLineupFromDeck(source,catalog);
  assert.equal(draft.units[0].cell,null);
  assert.equal(draft.units[0].star,1);
  assert.equal(draft.units[0].starOrigin,'editor_default_not_provided');
  draft.units[0].items.push('emblem');draft.source.stats.winRate=.9;
  assert.deepEqual(source,original);
  assert.equal(draft.origin,'source_snapshot');
});

test('verified Set 18 Elder Dragon uses two population slots and two Rift trait counts', async () => {
  const current = await getCatalog();
  const elder = unit('elder','DA_18_ElderDragon');
  const result=computeLineupTraits([elder,unit('second-elder','DA_18_ElderDragon')],current);
  assert.equal(result.find(trait=>trait.name==='峡谷野怪').count,2,'copies do not stack native traits');
  assert.equal(computeLineupPopulation([elder],current).requiredSlots,2);
  assert.equal(computeLineupPopulation([elder,unit('second-elder','DA_18_ElderDragon')],current).requiredSlots,4,'each copy occupies population');
  const unknown={...current,traits:current.traits.filter(trait=>trait.id!=='DA_18_ApexPredator')};
  assert.equal(computeLineupPopulation([elder],unknown).requiredSlots,null,'an absent special rule is never guessed');
  assert.equal(computeLineupPopulation([unit('unknown','not-in-catalog')],current).requiredSlots,null);
});
