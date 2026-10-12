import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExplorerIndex, searchExplorerEntities } from '../public/explorer-search.js';

const catalog = {
  champions: [
    { id: 'tree', name: '茂凯', cost: 5, traits: ['主宰'], aliases: ['Maokai'] },
    { id: 'azir', name: '阿兹尔', cost: 3, traits: ['裁决使'], aliases: ['Azir'] },
    { id: 'lux-base', name: '拉克丝', cost: 5, traits: ['自然之力！大元素使'], aliases: ['Lux'] },
    { id: 'lux-inferno', name: '拉克丝 (地狱火)', cost: 5, traits: ['地狱火'], aliases: ['Lux (Inferno)'] },
    { id: 'lux-coven', name: '拉克丝', cost: 5, traits: ['魔女'], aliases: ['Lux (Coven)'] },
    { id: 'unmapped', name: '未配置拼音的新英雄', cost: 3, traits: ['法师'], aliases: ['NewChampion'] },
  ],
  items: [
    { id: 'jewel', name: '珠光护手', aliases: ['Jeweled Gauntlet'] },
    { id: 'jewel-radiant', name: '光明版珠光护手', aliases: ['Radiant Jeweled Gauntlet'] },
    { id: 'rage', name: '鬼索的狂暴之刃' },
    { id: 'stone', name: '石像鬼石板甲' },
    { id: 'cost-name', name: '3费示例装备' },
    { id: 'jewel-copy', name: '珠光护手', aliases: [] },
  ],
  traits: [{ id: 'juggernaut', name: '主宰', aliases: ['Juggernaut'] }, { id: 'mage', name: '法师', aliases: ['Mage'] }],
};
const index = buildExplorerIndex(catalog);
const ids = (query, type) => searchExplorerEntities(index, query, type).map(result => result.entity.id);

test('common hero nickname, pinyin and initials resolve the same actual hero', () => {
  for (const query of ['大树', 'mk', 'maokai', 'mao kai', 'MaoKai', 'mǎo kǎi']) assert.deepEqual(ids(query, 'champion'), ['tree']);
  for (const query of ['沙皇', 'aze', 'azir']) assert.deepEqual(ids(query, 'champion'), ['azir']);
});

test('cost is a hero-only constraint, including mixed cost and trait/name queries', () => {
  assert.deepEqual(ids('3费'), ['azir', 'unmapped']);
  assert.deepEqual(ids('3费', 'item'), []);
  assert.deepEqual(ids('3费 裁决使'), ['azir']);
  assert.deepEqual(ids('5费大树'), ['tree']);
  assert.deepEqual(ids('3费 5费'), []);
});

test('native traits and their source English aliases match hero search metadata', () => {
  assert.deepEqual(ids('主宰', 'champion'), ['tree']);
  assert.deepEqual(ids('Juggernaut', 'champion'), ['tree']);
  assert.deepEqual(ids('zz', 'champion'), ['tree']);
  assert.equal(searchExplorerEntities(index, '主宰').find(result => result.entity.id === 'tree').matchKind, 'native_trait');
  assert.deepEqual(ids('法师', 'item'), []);
});

test('same-name Lux forms retain distinct IDs and original entity references', () => {
  for (const query of ['lux', 'lks', '光辉']) assert.deepEqual(new Set(ids(query, 'champion')), new Set(['lux-base', 'lux-inferno', 'lux-coven']));
  assert.deepEqual(ids('Lux Inferno', 'champion'), ['lux-inferno']);
  assert.equal(searchExplorerEntities(index, '大树')[0].entity, catalog.champions[0]);
});

test('item nicknames bind exact names and do not leak to radiant variants', () => {
  assert.deepEqual(ids('法爆', 'item'), ['jewel', 'jewel-copy']);
  assert.deepEqual(ids('羊刀', 'item'), ['rage']);
  assert.deepEqual(ids('板甲', 'item'), ['stone']);
  assert.ok(!ids('fb', 'item').includes('jewel-radiant'));
  assert.ok(ids('Jeweled Gauntlet', 'item').includes('jewel'));
});

test('no absent entity is created, unsupported spelling stays absent and catalog is immutable', () => {
  const original = structuredClone(catalog);
  const subset = buildExplorerIndex({ champions: [{ id: 'azir', name: '阿兹尔', cost: 3 }] });
  for (const text of ['大树', 'mk', '法爆', '根本不存在', 'weipeizhixinyingxiong']) assert.deepEqual(searchExplorerEntities(subset, text), []);
  buildExplorerIndex(catalog); searchExplorerEntities(index, '大树');
  assert.deepEqual(catalog, original);
});

test('empty, malformed and unsupported type inputs are safe', () => {
  assert.deepEqual(searchExplorerEntities(index, ''), []);
  assert.deepEqual(searchExplorerEntities(index, null), []);
  assert.deepEqual(searchExplorerEntities(index, '大树', 'augment'), []);
  assert.deepEqual(searchExplorerEntities(buildExplorerIndex(null), '大树'), []);
  assert.deepEqual(ids('法爆', 'items'), ids('法爆', 'item'));
});
