import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTerms, rankLexical, reciprocalRankFusion, searchKnowledge } from '../server/knowledge/service.mjs';
import { getCatalog } from '../server/data.mjs';
import { getLibrarySnapshot } from '../server/library-data.mjs';
import { getSeasonMechanic } from '../server/mechanics-data.mjs';
import { buildKnowledgeBundle } from '../server/knowledge/bundle.mjs';

const config={backend:'local_json',redisUrl:'',milvusUrl:'',embedding:{baseUrl:'',key:'',model:'',dimensions:0}};
const release={id:'fixture-release',season:18,currentPatch:'18.4'};
const chunk=(id,extra={})=>({id,documentId:`doc:${id}`,title:'商店概率',text:'商店概率的已核验规则。',sourcePatch:'18.4',eligible:true,
  entityIds:['trait:fixture'],source:{url:'https://example.com/rules'},document:{aliases:[]},...extra});
const deps=chunks=>({config,databaseMode:false,corpus:{release,chunks}});
const vectorConfig={...config,milvusUrl:'http://unused.invalid',embedding:{baseUrl:'https://example.com/v1',key:'fixture',model:'fixture',dimensions:2}};
const vectorDeps=(chunks,rows,overrides={})=>({...deps(chunks),config:vectorConfig,databaseMode:true,
  getIndexJob:async()=>({state:'ready',collection_name:'test',indexed_chunks:chunks.length}),
  embedTexts:async()=>[[0.1,0.2]],searchVector:async()=>rows,...overrides});

test('exact document aliases outrank incidental English words and match aliases inside questions',()=>{
  const target=chunk('shop',{title:'商店概率、卡池与升级经验',document:{aliases:['Shop odds']}});
  const noisy=chunk('wisp',{title:'法杖出现规则',text:'cooldown unit: wisp_shops'});
  assert.equal(rankLexical([noisy,target],'Shop odds')[0].chunk.id,'shop');
  assert.equal(rankLexical([noisy,target],'Can you explain Shop odds?')[0].chunk.id,'shop');
  const orb=chunk('orb',{title:'战利品法球',document:{aliases:['Loot Orb Contents']}});
  const other=chunk('healing',{title:'Healing Orbs',text:'Gain a healing orb.'});
  assert.equal(rankLexical([other,orb],'Loot Orb Contents')[0].chunk.id,'orb');
});

test('real local library English aliases resolve to their source topics without embeddings',async()=>{
  const catalog=await getCatalog();
  const [library,mechanics]=await Promise.all([getLibrarySnapshot({catalog}),getSeasonMechanic({catalog})]);
  const bundle=buildKnowledgeBundle({catalog,library,mechanics}),documents=new Map(bundle.documents.map(d=>[d.id,d]));
  const chunks=bundle.chunks.map(c=>({...c,document:documents.get(c.documentId).payload,source:documents.get(c.documentId).source}));
  for(const [query,documentId] of [['Shop odds','library:shop-odds'],['Loot Orb Contents','library:loot-orb-contents']]){
    const result=await searchKnowledge({query,limit:2},deps(chunks));
    assert.equal(result.retrieval.mode,'lexical');
    assert.equal(result.retrieval.vectorStatus,'not_configured');
    assert.equal(result.evidence[0].documentId,documentId);
  }
});

test('single digit conditions remain searchable without matching unrelated larger numbers',()=>{
  assert.ok(queryTerms('8级概率').includes('8'));
  const rows=rankLexical([chunk('eighteen',{title:'18级',text:'来源18.4'}),chunk('eight',{title:'8级',text:'8级概率'})],'8');
  assert.deepEqual(rows.map(r=>r.chunk.id),['eight']);
});

test('knowledge scope rejects old, unknown and ineligible evidence before ranking and enforces entity scope',async()=>{
  const rows=[chunk('current'),chunk('old',{sourcePatch:'18.3'}),chunk('unknown',{sourcePatch:null}),chunk('denied',{eligible:false}),
    chunk('other',{entityIds:['trait:other']})];
  const result=await searchKnowledge({query:'商店概率',entityId:'fixture'},deps(rows));
  assert.deepEqual(result.evidence.map(e=>e.id),['current']);
  assert.equal(result.context.gamePatch,'18.4');
});

test('evidence includes actual source.assets images with deduplication and excludes executable URLs',async()=>{
  const row=chunk('images',{source:{url:'https://example.com/rules',assets:[{url:'https://example.com/orbs.png'},{url:'javascript:alert(1)'}]},
    document:{images:['/assets/library/loot-orbs.png'],source:{assets:[{url:'https://example.com/orbs.png'}]}}});
  const result=await searchKnowledge({query:'商店概率'},deps([row]));
  assert.deepEqual(result.evidence[0].images,['/assets/library/loot-orbs.png','https://example.com/orbs.png']);
});

test('RRF rewards agreement between independent rankings and ignores duplicate IDs in one ranking',()=>{
  assert.deepEqual(reciprocalRankFusion([['a','b'],['b','c']]),['b','a','c']);
  assert.deepEqual(reciprocalRankFusion([['a','a','b'],['b','c']]),reciprocalRankFusion([['a','b'],['b','c']]));
});

test('empty results and unavailable stores have distinct status without falling back to another version',async()=>{
  const empty=await searchKnowledge({query:'不存在的机制'},deps([]));
  assert.equal(empty.status,'not_found'); assert.deepEqual(empty.evidence,[]); assert.equal(empty.retrieval.mode,'lexical');
  const unavailable=await searchKnowledge({query:'商店概率'},{config,databaseMode:false,corpus:async()=>{throw new Error('offline');}});
  assert.equal(unavailable.status,'unavailable'); assert.deepEqual(unavailable.evidence,[]); assert.equal(unavailable.retrieval.mode,'unavailable');
});

test('a cached withdrawn record is rejected and fresh eligible evidence replaces it',async()=>{
  const old=await searchKnowledge({query:'商店概率'},deps([chunk('withdrawn')]));
  let writes=0;
  const result=await searchKnowledge({query:'商店概率'},{...deps([chunk('withdrawn',{eligible:false}),chunk('current')]),
    cacheGet:async()=>old,cacheSet:async(_key,value)=>{writes++;assert.deepEqual(value.evidence.map(e=>e.id),['current']);}});
  assert.equal(result.retrieval.cacheHit,false);
  assert.deepEqual(result.evidence.map(e=>e.id),['current']); assert.equal(writes,1);
});

test('a cache hit rehydrates text and sources from the current allowed corpus',async()=>{
  const old=await searchKnowledge({query:'商店概率'},deps([chunk('current')]));
  old.evidence[0].text='Untrusted cached stale text';
  old.evidence[0].source={url:'https://example.com/stale'};
  const fresh=chunk('current',{text:'当前权威正文。',source:{url:'https://example.com/current'}});
  const result=await searchKnowledge({query:'商店概率'},{...deps([fresh]),cacheGet:async()=>old});
  assert.equal(result.retrieval.cacheHit,true);
  assert.equal(result.evidence[0].text,fresh.text); assert.deepEqual(result.evidence[0].source,fresh.source);
});

test('cache entries from another release, patch, or entity cannot become current evidence',async()=>{
  const cached=await searchKnowledge({query:'商店概率'},deps([chunk('current')]));
  for(const value of [{...cached,releaseId:'other-release'},{...cached,context:{...cached.context,gamePatch:'18.3'}}]){
    const result=await searchKnowledge({query:'商店概率'},{...deps([chunk('current')]),cacheGet:async()=>value});
    assert.equal(result.retrieval.cacheHit,false);
  }
  const result=await searchKnowledge({query:'商店概率',entityId:'other'},{...deps([chunk('current'),chunk('other',{entityIds:['trait:other']})]),cacheGet:async()=>cached});
  assert.equal(result.retrieval.cacheHit,false); assert.deepEqual(result.evidence.map(e=>e.id),['other']);
});

test('cache failures preserve a successful authoritative query',async()=>{
  const result=await searchKnowledge({query:'商店概率'},{...deps([chunk('current')]),cacheGet:async()=>{throw new Error('cache offline');},cacheSet:async()=>{throw new Error('cache offline');}});
  assert.equal(result.status,'ready'); assert.equal(result.retrieval.cacheHit,false);
});

test('dense IDs are scoped to current allowed facts before RRF and actual evidence hydration',async()=>{
  const vectorConfig={...config,milvusUrl:'http://unused.invalid',embedding:{baseUrl:'https://example.com/v1',key:'fixture',model:'fixture',dimensions:2}};
  const result=await searchKnowledge({query:'语义问题'},{...deps([chunk('current'),chunk('old',{sourcePatch:'18.3'}),chunk('denied',{eligible:false})]),
    config:vectorConfig,databaseMode:true,getIndexJob:async()=>({state:'ready',collection_name:'test',indexed_chunks:1}),
    embedTexts:async()=>[[0.1,0.2]],searchVector:async()=>[{id:'old',distance:0.99},{id:'denied',distance:0.98},{id:'missing',distance:0.97},{id:'current',distance:0.8}]});
  assert.equal(result.retrieval.mode,'hybrid'); assert.equal(result.retrieval.vectorStatus,'ready');
  assert.deepEqual(result.evidence.map(e=>e.id),['current']);
});

test('a nonempty vector corpus rejects unrelated low scores without falling back to lexical',async()=>{
  const result=await searchKnowledge({query:'请给我番茄炒蛋的做法'},vectorDeps([chunk('shop')],[{id:'shop',distance:0.3614}]));
  assert.equal(result.status,'not_found');assert.deepEqual(result.evidence,[]);
  assert.equal(result.retrieval.mode,'hybrid');assert.equal(result.retrieval.vectorStatus,'ready');
  assert.deepEqual(result.retrieval.relevance,{metric:'COSINE',minVectorScore:0.5,maxVectorScore:0.3614,
    acceptedVectorCandidates:0,strongLexicalCandidates:0,applied:true});
});

test('weak lexical overlap cannot bypass the vector relevance threshold',async()=>{
  const rows=[chunk('shop')],query='巴黎商店营业时间是什么？';
  assert.ok(rankLexical(rows,query).length);
  const result=await searchKnowledge({query},vectorDeps(rows,[{id:'shop',distance:0.3678}]));
  assert.equal(result.status,'not_found');assert.deepEqual(result.evidence,[]);
  assert.equal(result.retrieval.mode,'hybrid');assert.equal(result.retrieval.relevance.strongLexicalCandidates,0);
});

test('unknown and nonfinite vector scores never authorize semantic evidence',async()=>{
  const distances=[undefined,null,NaN,Infinity,-Infinity,'0.99'];
  const rows=distances.map((_,i)=>chunk(`invalid-${i}`));
  const result=await searchKnowledge({query:'请给我番茄炒蛋的做法'},vectorDeps(rows,rows.map((row,i)=>({id:row.id,distance:distances[i]}))));
  assert.equal(result.status,'not_found');assert.deepEqual(result.evidence,[]);
  assert.equal(result.retrieval.relevance.maxVectorScore,null);
  assert.equal(result.retrieval.relevance.acceptedVectorCandidates,0);
});

test('high relevance retrieves a colloquial question with no lexical overlap',async()=>{
  const rows=[chunk('interest',{title:'利息规则',text:'每10金币增加1利息。'})],query='兜里的钱放着会不会越变越多';
  assert.equal(rankLexical(rows,query).length,0);
  const result=await searchKnowledge({query},vectorDeps(rows,[{id:'interest',distance:0.635}]));
  assert.equal(result.status,'ready');assert.deepEqual(result.evidence.map(e=>e.id),['interest']);
  assert.equal(result.retrieval.relevance.acceptedVectorCandidates,1);
  assert.equal(result.retrieval.relevance.strongLexicalCandidates,0);
});

test('exact aliases, full titles and explicit entity scope preserve strong lexical evidence',async()=>{
  const target=chunk('shop',{document:{aliases:['Shop odds']}});
  const other=chunk('noise',{title:'商店营业时间',text:'附近的商店。',entityIds:['trait:other']});
  for(const input of [{query:'Can you explain Shop odds?'},{query:'商店概率'},{query:'这个怎么用？',entityId:'fixture'}]) {
    const result=await searchKnowledge(input,vectorDeps([target,other],[{id:'shop',distance:0.1},{id:'noise',distance:0.1}]));
    assert.equal(result.status,'ready');assert.deepEqual(result.evidence.map(e=>e.id),['shop']);
    assert.equal(result.retrieval.relevance.acceptedVectorCandidates,0);
    assert.equal(result.retrieval.relevance.strongLexicalCandidates,1);
  }
  const plural=await searchKnowledge({query:'Shop oddslots'},vectorDeps([target],[{id:'shop',distance:0.1}]));
  assert.equal(plural.status,'not_found');
});

test('threshold changes isolate cached results without selecting a new embedding index',async()=>{
  const cache=new Map(),reads=[],profiles=[];let embeddings=0;
  const rows=[chunk('shop')],dense=[{id:'shop',distance:0.6}],input={query:'把钱存着能赚钱吗？'};
  const dependencies=minVectorScore=>vectorDeps(rows,dense,{config:{...vectorConfig,knowledgeMinVectorScore:minVectorScore},
    getIndexJob:async(_release,profile)=>{profiles.push(profile);return {state:'ready',collection_name:'same-index'};},
    embedTexts:async()=>{embeddings++;return [[0.1,0.2]];},
    cacheGet:async key=>{reads.push(key);return cache.get(key);},cacheSet:async(key,value)=>{cache.set(key,value);}});
  const permissive=await searchKnowledge(input,dependencies(0.5));
  const strict=await searchKnowledge(input,dependencies(0.7));
  const strictAgain=await searchKnowledge(input,dependencies(0.7));
  assert.equal(permissive.status,'ready');assert.equal(strict.status,'not_found');assert.equal(strictAgain.status,'not_found');
  assert.equal(strict.retrieval.cacheHit,false);assert.equal(strictAgain.retrieval.cacheHit,true);
  assert.notEqual(reads[0],reads[1]);assert.equal(reads[1],reads[2]);assert.ok(reads.every(key=>key.startsWith('knowledge:v5:')));
  assert.equal(new Set(profiles).size,1);assert.equal(embeddings,2);
  // Also reject a stale payload if a cache implementation returns the wrong key.
  const wrongCache=await searchKnowledge(input,{...dependencies(0.7),cacheGet:async()=>permissive});
  assert.equal(wrongCache.status,'not_found');assert.equal(wrongCache.retrieval.cacheHit,false);
});

test('embedding outage explicitly falls back to lexical and does not cache the degraded result',async()=>{
  const vectorConfig={...config,milvusUrl:'http://unused.invalid',embedding:{baseUrl:'https://example.com/v1',key:'fixture',model:'fixture',dimensions:2}};
  let writes=0;
  const result=await searchKnowledge({query:'商店概率'},{...deps([chunk('current')]),config:vectorConfig,databaseMode:true,
    getIndexJob:async()=>({state:'ready',collection_name:'test',indexed_chunks:1}),embedTexts:async()=>{throw new Error('offline');},cacheSet:async()=>{writes++;}});
  assert.equal(result.status,'ready'); assert.equal(result.retrieval.mode,'lexical'); assert.equal(result.retrieval.vectorStatus,'unavailable'); assert.equal(writes,0);
});

test('invalid queries are rejected before loading any corpus',async()=>{
  let reads=0; const dependencies={config,corpus:async()=>{reads++;return {release,chunks:[]};}};
  for(const input of [{query:''},{query:'规则',entityId:{}},{query:'规则',limit:9}])await assert.rejects(searchKnowledge(input,dependencies),error=>error.status===400);
  assert.equal(reads,0);
});
