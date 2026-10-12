import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPatchIndex} from '../server/patch-entities.mjs';
import {patchCards} from '../server/patch-cards.mjs';
import {articleContent} from '../server/patch-content.mjs';
test('index includes set traits omitted by catalog display filters and localized emblem aliases',()=>{
 const c={context:{set:18,mutator:'TFTSet18',assetVersion:'16.20'},champions:[],items:[],traits:[],augments:[]};
 const raw=Object.fromEntries(['en_us','zh_cn','zh_tw'].map(l=>[l,{setData:[{number:18,mutator:'TFTSet18',champions:[],traits:[{apiName:'trait',name:l==='zh_tw'?'月光使者':'Lunar',icon:'assets/trait.tex'}],items:[]}],items:[{apiName:'emblem',name:l==='zh_tw'?'月華徽章':'Lunar Emblem',associatedTraits:['trait']}]}]));
 const idx=buildPatchIndex(c,raw);assert.equal(idx.entities.length,1);assert.ok(idx.entities[0].aliases.includes('月華'));
 const cards=patchCards({locale:'zh-tw',content:articleContent('<h4>特性</h4><ul><li>月華<ul><li>魔攻：10 ⇒ 12</li></ul></li></ul>')},idx);assert.equal(cards.traits[0].entityId,'trait');assert.match(cards.traits[0].icon,/trait.png$/);
});
test('unmatched nested new entity preserves the entity heading and upgrade detail',()=>{
 const cards=patchCards({locale:'en-us',content:articleContent('<h4>Wisps</h4><ul><li>New Wisp: gain 10 Mana<ul><li>Upgrade: gain 15 Mana</li></ul></li></ul>')},{entities:[]});assert.equal(cards.wisps.length,1);assert.equal(cards.wisps[0].originalName,'New Wisp: gain 10 Mana');assert.match(cards.wisps[0].body,/Upgrade: gain 15 Mana/);assert.equal(cards.wisps[0].matchStatus,'unresolved');
});
test('ambiguous aliases never silently pick an unrelated icon',()=>{
 const entities=['one','two'].map(id=>({id,category:'augments',names:{en_us:id},aliases:['Shared name'],icon:id+'.png'}));
 const cards=patchCards({locale:'en-us',content:articleContent('<h4>Augments</h4><ul><li>Shared name: 1 ⇒ 2</li></ul>')},{entities});
 assert.equal(cards.augments[0].entityId,null);assert.equal(cards.augments[0].icon,null);
});
test('base and upgraded Wisp share a verified family icon without treating unrelated names as synonyms',()=>{
 const entities=['base','upgraded'].map(variant=>({id:variant,category:'wisps',names:{en_us:'Drizzle'},aliases:[],icon:'wisp.png',variant,familyId:'base'}));
 const cards=patchCards({locale:'en-us',content:articleContent('<h4>Wisps</h4><ul><li>Drizzle: gain 10 mana</li></ul>')},{entities});
 assert.equal(cards.wisps[0].entityId,'base');assert.equal(cards.wisps[0].icon,'wisp.png');
});
