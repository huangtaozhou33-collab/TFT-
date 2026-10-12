import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const catalog=JSON.parse(fs.readFileSync(new URL('../data/catalog.json',import.meta.url)));
const {entries}=JSON.parse(fs.readFileSync(new URL('../public/locales/item-descriptions.json',import.meta.url)));
test('equipment translations cover the saved catalog and bind to exact source text',()=>{
 const index=new Map(entries.map(entry=>[entry.id,entry]));
 assert.equal(index.size,entries.length);
 for(const item of catalog.items){
  const entry=index.get(item.id);
  assert.ok(entry,`missing translation: ${item.id}`);
  assert.equal(entry.source,item.description,`stale translation: ${item.id}`);
  assert.match(entry.zh,/[\u3400-\u9fff]/u);
  assert.equal(entry.translationKind,'project_translation');
  const numbers=text=>(text.match(/\d+(?:\.\d+)?/g)||[]).sort();
  // "per gold" becomes explicit "per 1 gold" in Chinese.
  const chinese=item.id==='DA_Artifact_GamblersBlade'?entry.zh.replace('每拥有1金币','每拥有金币'):entry.zh;
  assert.deepEqual(numbers(chinese),numbers(entry.source),`numeric drift: ${item.id}`);
  assert.equal((entry.zh.match(/[?？]/g)||[]).length,(entry.source.match(/\?/g)||[]).length,`unknown values: ${item.id}`);
 }
});

