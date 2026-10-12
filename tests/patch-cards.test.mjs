import {test} from 'node:test';
import assert from 'node:assert/strict';
import {articleContent} from '../server/patch-content.mjs';
import {patchCards,simplifiedArticle} from '../server/patch-cards.mjs';
const index={entities:[{id:'a',category:'champions',icon:'icon-a',names:{zh_cn:'卡蜜尔',zh_tw:'卡蜜兒',en_us:'Camille'}},{id:'b',category:'augments',icon:'icon-b',names:{zh_cn:'测试',zh_tw:'測試',en_us:'Test'}}]};
test('nested changes stay together, quoted entities map and unknowns survive',()=>{
 const a={locale:'zh-tw',content:articleContent('<h2>大型改動</h2><h4>單位：1費</h4><ul><li>卡蜜兒<ul><li>傷害：10 ⇒ 12</li><li>生命：20 ⇒ 30</li></ul></li><li>未知英雄：5 ⇒ 6</li></ul><h4>增幅裝置</h4><ul><li>「測試」金幣：2 ⇒ 3</li></ul><h2>錯誤修正</h2><ul><li>不應歸入增幅</li></ul>')};
 const g=patchCards(a,index);assert.equal(g.champions.length,2);assert.equal(g.champions[0].name,'卡蜜尔');assert.match(g.champions[0].body,/20 ⇒ 30/);assert.equal(g.champions[1].icon,null);assert.equal(g.augments.length,1);assert.equal(g.augments[0].entityId,'b');
});
test('English text and hotfix batch retained; partial entity prefix rejected',()=>{
 const a={locale:'en-us',content:articleContent('<h2>Mid-patch update</h2><h4>Champions</h4><ul><li>Camille HP: 5 ⇒ 6</li><li>CamilleFake HP: 5 ⇒ 6</li></ul>')};const g=patchCards(a,index);assert.equal(g.champions[0].entityId,'a');assert.equal(g.champions[1].entityId,null);assert.equal(g.champions[0].batch,'Mid-patch update');
});
test('simplified presentation never changes original article',()=>{const a={title:'裝備',summary:'單位',body:'傷害'};const b=simplifiedArticle(a);assert.equal(a.title,'裝備');assert.equal(b.title,'装备');});
test('grouped entities become individual cards without losing shared conditions',()=>{
 const a={locale:'en-us',content:articleContent('<h2>Changes</h2><h4>Champions</h4><ul><li>Only at level 9<ul><li>Camille<ul><li>HP: 5 ⇒ 6</li></ul></li><li>Unknown: 2 ⇒ 3</li></ul></li></ul>')};const g=patchCards(a,index);assert.equal(g.champions.length,2);assert.equal(g.champions[0].entityId,'a');assert.match(g.champions[0].body,/Only at level 9/);assert.match(g.champions[1].body,/Unknown: 2 ⇒ 3/);
});
