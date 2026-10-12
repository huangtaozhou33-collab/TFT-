import test from 'node:test';
import assert from 'node:assert/strict';
import { getGlossary, matchGlossaryTerms, matchGlossaryMentions } from '../server/knowledge/glossary.mjs';
import { buildKnowledgeBundle } from '../server/knowledge/bundle.mjs';
import { searchKnowledge } from '../server/knowledge/service.mjs';
import { contentHash } from '../server/knowledge/chunking.mjs';
import { answerChat, debugChatRetrieval } from '../server/chat.mjs';
import { buildExplorerIndex, searchExplorerEntities } from '../public/explorer-search.js';
import { readFileSync } from 'node:fs';

const glossary=getGlossary(), entries=glossary.entries;
const supplied=entries.filter(entry=>entry.provenance==='user_supplied_v4');
const bundle=buildKnowledgeBundle({glossary});
const documents=new Map(bundle.documents.map(doc=>[doc.id,doc]));
const chunks=bundle.chunks.map(chunk=>({...chunk,document:documents.get(chunk.documentId).payload,source:documents.get(chunk.documentId).source}));
const retrieval={databaseMode:false,config:{embedding:{model:'offline',dimensions:3,key:'',baseUrl:''}},corpus:{release:{id:'v4-offline',currentPatch:'18.4',season:18},chunks}};
const catalog=JSON.parse(readFileSync(new URL('../data/catalog.json',import.meta.url),'utf8'));
const deps={getCatalog:async()=>catalog,getGlossary:async()=>glossary,
  getLibrarySnapshot:async()=>({documents:[],augmentRules:[]}),getSeasonMechanic:async()=>({entries:[]}),
  getMetaDecks:async()=>assert.fail('definitions must not become comp recommendations'),
  getChampionBuild:async()=>assert.fail('definitions must not become builds'),
  getResearchResults:async()=>assert.fail('definitions must not inherit old filters'),
  searchKnowledge:input=>searchKnowledge(input,retrieval)};
const ids=query=>matchGlossaryTerms(query).map(entry=>entry.id);

test('V4 preserves all 184 supplied entries and seven legacy-only concepts, with honest evidence labels',()=>{
  assert.equal(entries.length,191);assert.equal(supplied.length,184);
  assert.equal(supplied.filter(entry=>entry.evidenceStatus==='source_supported').length,71);
  assert.equal(supplied.filter(entry=>entry.evidenceStatus==='editorial_common_usage').length,113);
  assert.equal(new Set(supplied.map(entry=>entry.category)).size,14);
  for(const entry of supplied){
    assert.ok(entry.exampleQuestion && entry.exampleAnswer && entry.disambiguation && entry.applicability,entry.id);
    assert.equal(entry.sourcePatch,null);assert.equal(entry.verificationStatus,'not_independently_verified');
    assert.deepEqual(entry.examples,[`问：${entry.exampleQuestion}`,`答：${entry.exampleAnswer}`]);
    if(entry.evidenceStatus==='source_supported')assert.ok(entry.references.length,entry.id);
    for(const url of entry.references)assert.equal(new URL(url).protocol,'https:');
  }
  for(const term of ['经济','战力','节奏','追二','站位','装备消化','备战席'])assert.ok(entries.some(entry=>entry.term===term));
  assert.deepEqual(ids('稳血和锁血'),['preserve-health','stabilize']);
  assert.deepEqual(ids('保连胜和连胜'),['protect-win-streak','win-streak']);
  assert.deepEqual(ids('经济运营和经济'),['operations','economy']);
});

test('every supplied term and example question can retrieve its own atomic card without a model',async()=>{
  for(const entry of supplied){
    for(const query of [entry.term,entry.exampleQuestion]){
      const result=await searchKnowledge({query,limit:8},retrieval);
      assert.ok(result.evidence.some(e=>e.documentId===`glossary:${entry.id}`),`${entry.id}: ${query}`);
    }
  }
});

test('longest mentions and ASCII boundaries prevent collisions while matching numeric community forms',()=>{
  for(const [query,expected] of [
    ['大天使给谁',['archangels']],['主C带破甲弓',['primary-carry','last-whisper']],
    ['法爆拳',['jeweled-gauntlet']],['启动装',['mana-items']],['装备海克斯',['equipment-augment']],
    ['一波容错',['one-loss-margin']],['卡利息D',['slow-roll']],['吃3息',['earn-interest']],
    ['先D两下',['roll']],['4-2启动',['stage-round','spend-start','combat-start']],
    ['ＡＤＣ_Draven_unknown',[]],['1950',[]],['S10HeadlinerX',[]],
    ['英雄护甲和魔抗多少',[]],['攻击速度不够',[]],['选秀拿护甲',['chain-vest']],['野怪掉了个魔抗',['cloak']]])assert.deepEqual(ids(query),expected,query);
  assert.deepEqual(ids('这把又速八了'),['fast-eighth','fast-eight']);
});

test('polysemy retains distinct sense IDs, context ranking and an explicit truncation signal',async()=>{
  for(const [query,expected] of [['速八是什么意思',['fast-eight','fast-eighth']],['卡牌是什么意思',['deny-units','twisted-fate']],['启动是什么意思',['combat-start','spend-start']]]){
    assert.deepEqual(ids(query),expected);
    const result=await searchKnowledge({query,limit:2},retrieval);
    assert.deepEqual(result.evidence.map(e=>e.documentId),expected.map(id=>`glossary:${id}`));
    assert.equal(result.terminology.mentions[0].ambiguous,true);
    assert.equal(result.terminology.truncated,false);
    const truncated=await searchKnowledge({query,limit:1},retrieval);
    assert.equal(truncated.terminology.truncated,true);
    assert.equal(truncated.terminology.mentions[0].candidates.length,2);
  }
  assert.equal(ids('这张卡启动太慢')[0],'combat-start');
  assert.equal(ids('下回合启动')[0],'spend-start');
  assert.deepEqual(ids('卡牌大师是哪张牌'),['twisted-fate']);
  assert.deepEqual(ids('速八出局'),['fast-eighth']);
});

test('metadata survives bundle, retrieval and the real Chat adapter into mocked model input',async()=>{
  const question='速八是什么意思？';let calls=0;
  const result=await answerChat({messages:[{role:'user',content:question}],pageContext:{readonly:true}}, {...deps,
    chatCompletion:async messages=>{
      calls++;
      const raw=messages.find(row=>row.content?.startsWith('工具 search_knowledge'));
      const message=raw??messages.find(row=>row.role==='system'&&row.content.includes('"citationMap"'));
      assert.ok(message);
      const tool=JSON.parse(message.content.split('\n')[1]);
      assert.equal(tool.terminology.mentions[0].ambiguous,true);
      assert.equal(tool.evidence.length,2);
      for(const evidence of tool.evidence){
        assert.equal(evidence.evidenceStatus,'source_supported');assert.equal(evidence.verificationStatus,'not_independently_verified');
        assert.equal(evidence.sourcePatch,null);assert.match(evidence.text,/本次接入未逐条独立复核/);
        assert.equal(tool.citationMap[evidence.citation],evidence.title);
      }
      assert.ok(messages[0].content.includes('绝不全局替换原问题'));
      return {message:{content:tool.evidence.map(e=>`${e.title}${e.citation}`).join('；')}};
    }});
  assert.equal(calls,1);assert.equal(result.evidence.filter(e=>e.type==='knowledge').length,2);
});

test('current entity lookup attaches supplied hero nicknames only to real catalog rows',()=>{
  const heroes=supplied.filter(entry=>entry.canonicalEntity);
  for(const entry of heroes){
    const entity={id:`fixture-${entry.id}`,name:entry.canonicalEntity.name};
    const index=buildExplorerIndex({champions:[entity]});
    for(const alias of [entry.term,...entry.aliases])assert.ok(searchExplorerEntities(index,alias,'champion').some(row=>row.entity.id===entity.id),alias);
    assert.deepEqual(searchExplorerEntities(buildExplorerIndex({champions:[]}),entry.term,'champion'),[]);
  }
});

test('pure meaning questions ignore stale explorer filters and historical identities are not invented',async()=>{
  const context={view:'explorer',readonly:true,research:{conditions:[{type:'champion',id:catalog.champions[0].id}],minSample:100}};
  for(const question of ['吃分就是进前四吗？','三费就是三星吗？','天选和赛季之星有什么区别？','稳血和锁血有什么区别？','运营就是一直存钱吗？']){
    const preview=await debugChatRetrieval({question,pageContext:context},deps);
    assert.deepEqual(preview.tools.map(tool=>tool.name),['search_knowledge'],question);
  }
  const missing=await debugChatRetrieval({question:'狗头是哪张牌？',pageContext:context},{...deps,getCatalog:async()=>({...catalog,champions:[]})});
  assert.deepEqual(missing.tools.map(tool=>tool.name),['search_catalog','search_knowledge']);
  assert.deepEqual(missing.tools[0].result.matched,[]);
  assert.match(missing.tools[1].result.evidence[0].text,/当前赛季是否存在该英雄未核验/);
});

test('no-result and unavailable corpus remain explicit; old publications do not receive newer vocabulary',async()=>{
  const result=await searchKnowledge({query:'星砂回响连锁是什么意思'},retrieval);
  assert.equal(result.status,'not_found');assert.deepEqual(result.evidence,[]);
  const failed=await searchKnowledge({query:'速八'}, {...retrieval,corpus:()=>{throw Error('offline fixture');}});
  assert.equal(failed.status,'unavailable');assert.deepEqual(failed.evidence,[]);
  const old=await searchKnowledge({query:'速八'}, {...retrieval,corpus:{...retrieval.corpus,chunks:chunks.filter(c=>c.document.id==='fast-eight')}});
  assert.equal(old.evidence.length,1);assert.equal(old.terminology.mentions[0].ambiguous,false);
  const custom={id:'published-only',term:'发布独有词',aliases:[],definition:'发布内容'};
  assert.deepEqual(matchGlossaryMentions('发布独有词',[custom])[0].candidates,[custom]);
});

test('invalid evidence labels and unsafe references are rejected before publication',()=>{
  for(const edit of [entry=>entry.evidenceStatus='official_verified',entry=>entry.references=['javascript:alert(1)'],entry=>entry.references=['https://user:pass@example.com/']]){
    const invalid=structuredClone(glossary);edit(invalid.entries[0]);
    invalid.revision=`editorial-v1-${contentHash(invalid.entries).slice(0,16)}`;invalid.source.revision=invalid.revision;
    assert.throws(()=>buildKnowledgeBundle({glossary:invalid}),/evidence metadata/);
  }
});
