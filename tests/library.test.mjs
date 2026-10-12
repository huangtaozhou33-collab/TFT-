import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {getLibrarySnapshot,getLibraryKnowledge,readLibrarySnapshot,validateLibrary,parseReferenceCSV} from '../server/library-data.mjs';
import {normalizeAugmentRules,translateOfferingCondition} from '../scripts/library-rules.mjs';
import {cacheKeyFor,sha256} from '../scripts/stats-cache.mjs';
import {debugChatRetrieval} from '../server/chat.mjs';
import {getDeveloperTrace} from '../server/developer-traces.mjs';

const catalog=JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url),'utf8'));
const pack=await readLibrarySnapshot(catalog);
assert.ok(pack,'V3 requires the checked-in reviewed Chinese library release.');
test('reviewed release covers every current navigation topic and links native rewards to exact catalog entities',async()=>{
  const snapshot=await getLibrarySnapshot({catalog});
  assert.equal(snapshot.status,'ready');
  assert.deepEqual(snapshot.coverage.byCategory,{system:8,augment:19,trait:8,wisp:4,reference:5});
  assert.equal(snapshot.coverage.documents,44);assert.equal(snapshot.coverage.augmentRules,248);
  assert.equal(snapshot.offeringCoverage.missingIds.length,1);
  assert.equal(snapshot.offeringCoverage.missingIds[0],'DA_DoubleTrouble');
  assert.ok(snapshot.documents.every(doc=>doc.rules.every(text=>/[\u4e00-\u9fff]/u.test(text))));
  assert.equal(snapshot.documents.find(doc=>doc.id==='trait-ladder').source.pagePatch,'18.4');
  assert.equal(snapshot.documents.find(doc=>doc.id==='trait-ladder').sourcePatch,'18.4');
  const rift=snapshot.documents.find(doc=>doc.id==='riftbeast');
  assert.ok(rift.rules.some(text=>text.includes('至少出现1张')));
  assert.ok(rift.rules.some(text=>text.includes('不使用普通商店费用分布')));
});
test('Trait Ladder selects the conditional six-trait branches, preserving independent 50% rewards and original provenance',async()=>{
  const result=await getLibraryKnowledge({query:'羁绊阶梯6个羁绊是什么奖励',catalog});
  assert.equal(result.data[0].id,'trait-ladder');
  assert.deepEqual(result.data[0].tables[0].rows.map(row=>[row.probability,row.cells[2]]),[[.5,'7金币'],[.5,'2个3费弈子']]);
  assert.match(result.data[0].tables[0].probabilityBasis,/门槛/);
  assert.equal(result.augmentRules[0].id,'DA_TraitLadder');
  assert.equal(result.data[0].source.fetchedAt,pack.payload.documents.find(doc=>doc.id==='trait-ladder').source.fetchedAt);
});
test('reference and conflicting values remain visible in the frontend snapshot but never reach current numeric retrieval',async()=>{
  for(const id of ['sprykin','frontline-foundation','bonus-gift','star-scaling']) {
    assert.ok(pack.payload.documents.find(doc=>doc.id===id).tables[0].rows.length);
    const result=await getLibraryKnowledge({id,catalog});
    assert.equal(result.data[0].retrievalEligible,false,id);assert.equal(result.data[0].tables,undefined,id);assert.ok(result.data[0].reason);
  }
  const invalid=structuredClone(pack.payload);invalid.documents.find(doc=>doc.id==='bonus-gift').retrievalEligible=true;
  assert.equal(validateLibrary(invalid,catalog).valid,false);
  const probability=structuredClone(pack.payload);probability.documents.find(doc=>doc.id==='trait-ladder').tables[0].rows[0].probability=.4;
  assert.ok(validateLibrary(probability,catalog).errors.some(error=>error.includes('概率和异常')));
});
test('offering CSV uses exact stage variants, per-round uniqueness and structured exclusions; unexpected English conditions stop publication',()=>{
  const entities=catalog.augments.slice(0,2),headers=['Name','mName','Tier','Stage 2','Stage 3','Stage 4','Standard','Doubles','Tockers','1 Player','Special Conditions','MutuallyExclusiveItem1','Round Variants'];
  const text=[headers.join(','),['Original',entities[0].id,'Gold','Yes','','','Yes','','','1 Player','Requires at least 1 champion with 7 copies.',entities[1].id,'Early'].join(','),['Original+',entities[1].id,'Gold','','Yes','Yes','Yes','Yes','','','','','Late'].join(',')].join('\n');
  const result=normalizeAugmentRules(text,catalog);
  assert.deepEqual(result.rules[0].stages,[2]);assert.deepEqual(result.rules[1].stages,[3,4]);
  assert.match(result.rules[0].onePlayerNote,/每轮/);assert.match(result.rules[0].onePlayerNote,/奇遇/);
  assert.equal(result.rules[0].exclusions[0].id,entities[1].id);assert.match(result.rules[0].conditionsZh[0],/7张拷贝/);
  assert.throws(()=>translateOfferingCondition('A newly changed condition.'),/未翻译/);
  assert.deepEqual(parseReferenceCSV('Name,Notes\r\n"A, B","quoted ""text""\nnext"')[0],{Name:'A, B',Notes:'quoted "text"\nnext'});
  assert.throws(()=>parseReferenceCSV('Name,Name\nx,y'),/Duplicate/);
  assert.throws(()=>parseReferenceCSV('Name,Notes\n"open,'),/Unterminated/);
});
test('readers isolate rules/catalog revisions, reject checksums and never contact a source while reading',async()=>{
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('local rules must not fetch');
  const root=await mkdtemp(join(tmpdir(),'tft-library-')),dir=pathToFileURL(root+sep),base=new URL(`${cacheKeyFor(catalog)}/`,dir);
  try {
    await mkdir(base,{recursive:true});const text=JSON.stringify(pack.payload);
    await writeFile(new URL(pack.manifest.file,base),text);await writeFile(new URL('manifest.json',base),JSON.stringify({...pack.manifest,sha256:sha256(text)}));
    assert.equal((await getLibrarySnapshot({catalog,dir})).status,'ready');
    const changed=structuredClone(catalog);changed.context.rulesVersion+='-new';assert.equal((await getLibrarySnapshot({catalog:changed,dir})).status,'not_cached');
    const renamed=structuredClone(catalog);renamed.augments[0].name+='新名';assert.equal((await getLibrarySnapshot({catalog:renamed,dir})).status,'not_cached');
    await writeFile(new URL(pack.manifest.file,base),text+' ');assert.equal((await getLibrarySnapshot({catalog,dir})).status,'not_cached');
  } finally {globalThis.fetch=originalFetch;assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});}
});
test('assistant prefetch revalidates native knowledge context, cites the actual source and ignores client-supplied table values',async()=>{
  const dependencies={getCatalog:async()=>catalog,getSeasonMechanic:async()=>({entries:[],status:'not_cached'})};
  const preview=await debugChatRetrieval({question:'6个羁绊有什么奖励？',context:{view:'systems',libraryDocumentId:'trait-ladder',tableRows:[{reward:'999金币'}]}},dependencies);
  const tool=preview.tools.find(tool=>tool.name==='get_library_knowledge');assert.ok(tool);
  assert.equal(tool.result.data[0].id,'trait-ladder');assert.ok(tool.result.data[0].citation);
  assert.equal(JSON.stringify(tool.result).includes('999金币'),false);
  assert.deepEqual(tool.result.data[0].tables[0].rows.map(row=>row.probability),[.5,.5]);
  assert.ok(getDeveloperTrace(preview.traceId).citations.retrieved.some(source=>source.url==='https://www.littlebuddybot.com/tft-trait-ladder'&&source.sourcePatch==='18.4'));
  const unknown=await debugChatRetrieval({question:'解释这条规则',context:{view:'systems',libraryDocumentId:'fake-id'}},dependencies);
  assert.equal(unknown.tools.some(tool=>tool.name==='get_library_knowledge'),false);
});
test('new Chinese fallback uses the independently sourced 18.4 description, keeping the old asset text out of current assistant context',async()=>{
  const snapshot=await getLibrarySnapshot({catalog}),entity=catalog.augments.find(entity=>entity.id==='DA_EarlyLearnings');
  assert.ok(entity.description.includes('3%'));
  const rule=snapshot.augmentRules.find(rule=>rule.id===entity.id);assert.ok(rule.descriptionZh.includes('5%'));assert.ok(!/[a-z]{4,}/i.test(rule.descriptionZh));
  const preview=await debugChatRetrieval({question:'这个强化提供多少法强？',context:{view:'augments',entityId:entity.id}},{getCatalog:async()=>catalog,getSeasonMechanic:async()=>({entries:[],status:'not_cached'})});
  const page=getDeveloperTrace(preview.traceId).modelContext.find(segment=>segment.kind==='page_context');
  assert.ok(page.content.includes('队伍获得5%'));assert.ok(!page.content.includes('Your team gains 3%'));
  assert.ok(getDeveloperTrace(preview.traceId).citations.retrieved.some(source=>source.type==='mechanism_description'&&source.sourcePatch==='18.4'));
});
