import test from 'node:test';
import assert from 'node:assert/strict';
import { filterGlossaryEntries } from '../public/library.js';

const entries=[
  {id:'stabilize',term:'锁血',aliases:['稳血'],definition:'战力足以减轻后续血量损失。',examples:['大D以后找到关键二星，试图锁血。'],misconceptions:['不能保证每回合获胜。'],relatedTerms:['大D']},
  {id:'roll-down',term:'大D',aliases:['大搜','Roll down'],definition:'集中消耗金币刷新商店。',examples:['为提升即时战力大搜。'],misconceptions:['并非所有情形都要搜到零金币。'],relatedTerms:['慢D']},
  {id:'slow-roll',term:'慢D',aliases:['慢搜','Slow roll'],definition:'维持目标经济档位，用多出的金币刷新商店。',examples:['围绕利息搜牌。'],misconceptions:['不是无限等待，血量与牌库竞争会改变决策。'],relatedTerms:['大D']}
];

test('glossary exact term and alias outrank incidental mentions without changing source order',()=>{
  const original=JSON.stringify(entries);
  assert.equal(filterGlossaryEntries(entries,'大D')[0].id,'roll-down');
  assert.equal(filterGlossaryEntries(entries,'大搜')[0].id,'roll-down');
  assert.equal(JSON.stringify(entries),original);
});

test('glossary aliases tolerate width, case and whitespace while preserving Chinese definitions',()=>{
  assert.equal(filterGlossaryEntries(entries,' ＳＬＯＷ ＲＯＬＬ ')[0].id,'slow-roll');
  assert.equal(filterGlossaryEntries(entries,'慢ｄ')[0].id,'slow-roll');
  assert.deepEqual(filterGlossaryEntries(entries,'金币 档位').map(entry=>entry.id),['slow-roll']);
  assert.deepEqual(filterGlossaryEntries(entries,'每回合获胜').map(entry=>entry.id),['stabilize']);
});

test('glossary unknown searches remain empty and partial or missing snapshots are safe',()=>{
  assert.deepEqual(filterGlossaryEntries(entries,'未收录术语甲乙丙'),[]);
  assert.deepEqual(filterGlossaryEntries(undefined,'慢D'),[]);
  assert.deepEqual(filterGlossaryEntries(null,'慢D'),[]);
  assert.deepEqual(filterGlossaryEntries([{id:'basic',term:'基础'}],'基础').map(entry=>entry.id),['basic']);
  const all=filterGlossaryEntries(entries,'');
  assert.deepEqual(all,entries);assert.notEqual(all,entries);
});
