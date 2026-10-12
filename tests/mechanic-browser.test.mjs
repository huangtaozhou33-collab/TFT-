import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getSeasonMechanic} from '../server/mechanics-data.mjs';
import {offeringWindowAt,offeringPreview,mechanicSearchText} from '../public/mechanic-browser.js';
import {lootRewardTokens,LOOT_ATLAS,LOOT_ORBS} from '../public/library-visuals.js';
import {createHash} from 'node:crypto';

const catalog=JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url),'utf8'));
const mechanics=await getSeasonMechanic({catalog});
test('offering round filters use documented exact windows, retaining disputed boundaries and unknown forms',()=>{
  const drizzle=mechanics.entries.find(entry=>entry.nameEn==='Drizzle' && entry.upgrade?.variant==='base') || mechanics.entries.find(entry=>entry.id==='DA_18_Drizzle');
  assert.ok(drizzle);
  assert.equal(offeringWindowAt(drizzle,'4-1'),'conflict','the Riot/CSV 4-1 boundary must keep its source difference');
  assert.equal(offeringWindowAt(drizzle,'5-7'),'inside');
  assert.equal(offeringWindowAt(drizzle,'3-7'),'outside');
  assert.equal(offeringWindowAt(drizzle,'6-1'),'outside');
  assert.equal(offeringWindowAt(drizzle,'4-8'),'unknown');
  const unknown=mechanics.entries.find(entry=>!offeringPreview(entry).recorded);
  assert.ok(unknown); assert.equal(offeringWindowAt(unknown,'4-1'),'unknown');
  assert.equal(offeringPreview(unknown).cost,null);
  const conflict={offeringConditions:{status:'documented',roundWindow:[{from:'4-2',to:'5-7'}],conflicts:[{field:'roundWindow',riotValue:[{from:'4-1',to:'5-7'}],littleBuddyValue:[{from:'4-2',to:'5-7'}]}]}};
  assert.equal(offeringWindowAt(conflict,'4-1'),'conflict');
  assert.equal(offeringWindowAt(conflict,'4-2'),'inside');
});
test('library search finds wisps by Chinese offering conditions and exclusions, with the offered-shop cooldown intact',()=>{
  const drizzle=mechanics.entries.find(entry=>entry.id==='DA_18_Drizzle');
  assert.ok(mechanicSearchText(drizzle).includes('金币少于10'));
  assert.ok(mechanicSearchText(drizzle).includes('drizzle'));
  const excluded=mechanics.entries.find(entry=>entry.offeringConditions?.excludedBy?.some(augment=>augment.catalogMapped));
  const name=excluded.offeringConditions.excludedBy.find(augment=>augment.catalogMapped).name;
  assert.ok(mechanicSearchText(excluded).includes(name.normalize('NFKC').toLowerCase().replace(/\s/g,'')));
  const preview=offeringPreview(drizzle);
  assert.equal(preview.cost,0);
  assert.equal(preview.cooldown,drizzle.offeringConditions.cooldown.value);
  assert.equal(offeringPreview({offeringConditions:{...drizzle.offeringConditions,cooldown:{...drizzle.offeringConditions.cooldown,trigger:'purchased'}}}).cooldown,null);
});
test('library uses the unchanged reviewed game artwork, valid icon regions, and distinct small/regular duplicators',async()=>{
  const image=await readFile(new URL('../public'+LOOT_ATLAS.src,import.meta.url));
  assert.equal(createHash('sha256').update(image).digest('hex'),LOOT_ATLAS.sha256);
  assert.equal(image.readUInt32BE(16),LOOT_ATLAS.width);assert.equal(image.readUInt32BE(20),LOOT_ATLAS.height);
  const tokens=lootRewardTokens('2个3费弈子 + 次级英雄复制器 + 英雄复制器 + 3金币 + 1个棱彩球');
  assert.deepEqual(tokens.map(token=>token.name),['2个3费弈子','次级英雄复制器','英雄复制器','3金币','1个棱彩球']);
  assert.notDeepEqual(tokens[1].crop,tokens[2].crop);
  for(const visual of [...tokens,...LOOT_ORBS])assert.ok(visual.crop.x>=0&&visual.crop.y>=0&&visual.crop.x+visual.crop.w<=LOOT_ATLAS.width&&visual.crop.y+visual.crop.h<=LOOT_ATLAS.height);
});
