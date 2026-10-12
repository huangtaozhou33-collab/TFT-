import assert from 'node:assert/strict';
import { readConfig } from '../server/env.mjs';
const base = `http://127.0.0.1:${readConfig().port}`;
async function request(path, body) {
  const res = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  assert.equal(res.status, 200, `${path}: ${data.message || data.reason || res.status}`);
  return data;
}
const catalog = await request('/api/catalog');
const decks = await request('/api/decks');
assert(catalog.champions.length > 0 && catalog.items.length > 0);
assert(decks.status === 'live' && decks.data.length > 0);
const carry = catalog.champions.find(x => x.name === '阿狸') || catalog.champions[0];
const tank = catalog.champions.find(x => x.name === '奥恩') || catalog.champions[1];
const component = name => catalog.items.find(x => x.kind === 'component' && x.name === name)?.id;
const components = Object.fromEntries(['暴风大剑', '无用大棒', '女神之泪', '反曲之弓', '锁子甲', '巨人腰带', '拳套', '负极斗篷'].map(name => [component(name), name === '女神之泪' || name === '巨人腰带' || name === '拳套' ? 2 : 1]).filter(([id]) => id));
const draft = { version: 9, units: [{ instanceId: 'smoke-carry', championId: carry.id, role: 'carry', priority: 3, lockedItems: [] }, { instanceId: 'smoke-tank', championId: tank.id, role: 'tank', priority: 2, lockedItems: [] }], components, completedItems: {}, reserve: { [component('女神之泪')]: 1 } };
const { plan } = await request('/api/plan', { draft });
assert((await request('/api/plan/validate', { draft, plan })).valid);
assert(!(await request('/api/plan/validate', { draft: { ...draft, version: 10 }, plan })).valid);
console.log(JSON.stringify({ status: 'planning_ok', context: catalog.context, decks: decks.data.length, assignments: plan.assignments, reservedComponents: plan.reservedComponents }, null, 2));
if (process.argv.includes('--ai')) {
  const result = await request('/api/chat', { messages: [{ role: 'user', content: '请基于当前草案用装备规划工具分配全队装备，说明资源账本和预留的女神之泪。没有统计依据就不要说胜率最优。' }], pageContext: { view: 'workbench' }, draft, plan });
  assert(result.reply.trim() && result.plan && result.draftVersion === draft.version);
  assert(result.evidence.some(x => x.type === 'calculation'));
  console.log(JSON.stringify({ status: 'ai_tool_loop_ok', reply: result.reply, evidence: result.evidence, suggestedActions: result.suggestedActions, usage: result.usage }, null, 2));
}
