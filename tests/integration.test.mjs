import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { ROOT } from '../server/env.mjs';

// This suite uses the real local HTTP server and verified catalog. It never invokes
// an AI connection check or sends a valid chat that could reach a paid provider.
let port, base;
let ownedServer;
let catalog;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function healthReady() {
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(400) });
    const result = await response.json();
    return response.ok && result.version === '4.0.0' && result.status === 'ok';
  } catch { return false; }
}
async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json() };
}
async function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}
before(async () => {
  // Always exercise this checkout, never a user's long-running older server.
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  ownedServer = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, PORT: String(port), PUBLIC_PORT: String(port), HOST: '127.0.0.1', STORAGE_BACKEND: 'local_json' } });
  const deadline = Date.now() + 10_000;
  while (!await healthReady() && Date.now() < deadline) await pause(100);
  assert.equal(await healthReady(), true, 'isolated local server did not start');
  const response = await fetch(`${base}/api/catalog`);
  assert.equal(response.status, 200, 'verified static catalog must be synced before integration tests');
  catalog = await response.json();
  assert.ok(catalog.champions.length >= 2);
  assert.ok(catalog.items.some(item => item.kind === 'component'));
  assert.ok(catalog.items.some(item => item.kind === 'completed' && item.recipeVerified));
});
after(() => { ownedServer?.kill(); });

test('conditional build HTTP query returns exact triples with the fixed item and rejects contradictory conditions', async () => {
  const champion = catalog.champions.find(entity => /Veigar$/.test(entity.id));
  const item = catalog.items.find(entity => /Dawncore$/.test(entity.id));
  const result = await post('/api/builds/query', { championId: champion.id, requiredItemIds: [item.id], minSample: 100 });
  assert.equal(result.status, 200); assert.equal(result.body.status, 'ok');
  assert.ok(result.body.data.length > 0);
  assert.ok(result.body.data.every(row => row.championId === champion.id && row.itemIds.length === 3 && row.itemIds.includes(item.id) && row.stats.sampleSize >= 100));
  assert.deepEqual(result.body.best, result.body.data[0]);
  assert.equal(result.body.evidence.source, 'OP.GG MCP');
  assert.equal(result.body.evidence.sourcePatch, null);
  const conflict = await post('/api/builds/query', { championId: champion.id, requiredItemIds: [item.id], excludedItemIds: [item.id] });
  assert.equal(conflict.body.status, 'invalid'); assert.equal(conflict.body.best, null);
  assert.equal((await fetch(`${base}/build-explorer.js`)).status, 200);
  assert.equal((await fetch(`${base}/build-query.js`)).status, 200);
});

test('research HTTP query preserves holder conditions, returns three result groups and rejects invalid entities', async () => {
  const champion = catalog.champions.find(entity => /Veigar$/.test(entity.id));
  const item = catalog.items.find(entity => /Dawncore$/.test(entity.id));
  const result = await post('/api/research/query/v2', { conditions: [{ type: 'champion', id: champion.id }, { type: 'item', id: item.id, holderId: champion.id }], minSample: 500 });
  assert.equal(result.status, 200);
  assert.equal(result.body.schemaVersion, 2);
  assert.ok(result.body.equipment.rows.length > 0);
  assert.ok(result.body.equipment.rows.every(row => row.championId === champion.id && row.itemIds.includes(item.id) && row.stats.sampleSize >= 500));
  assert.ok(Array.isArray(result.body.teammates.rows)); assert.ok(Array.isArray(result.body.comps.rows));
  assert.equal(result.body.coverage.jointMatchQueries, false);
  assert.equal(result.body.equipment.evidence.sourcePatch, null);
  const invalid = await post('/api/research/query/v2', { conditions: [{ type: 'champion', id: 'unknown-hero' }] });
  assert.equal(invalid.status, 400);
  for (const path of ['/stats-browser.js', '/research-explorer.js', '/data-browser.css', '/assets/categories/artifact.svg']) assert.equal((await fetch(`${base}${path}`)).status, 200);
});

test('an already-open v1 explorer gets a refresh message instead of an incompatible successful response', async () => {
  const result = await post('/api/research/query', { conditions: [{ type: 'champion', id: catalog.champions[0].id }], minSample: 100 });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'CLIENT_UPDATE_REQUIRED');
  assert.match(result.body.message, /刷新.*筛选条件会保留/);
  assert.equal(result.body.endpoint, '/api/research/query/v2');
  assert.equal(result.body.equipment, undefined);
});

test('v3 OP.GG filter retrieves the existing Elder Dragon build instead of substituting Riot observations',async()=>{
  const conditions=[{type:'item',id:'DA_Artifact_SilvermereDawn',holderId:null},{type:'item',id:'DA_InfinityEdge',holderId:null},{type:'item',id:'DA_StrikersFlail',holderId:null}];
  const result=await post('/api/research/query/v3',{dataSource:'opgg',conditions,minSample:100,sort:'avgPlacement'});
  assert.equal(result.status,200);assert.equal(result.body.schemaVersion,3);assert.equal(result.body.source,'opgg');
  const dragon=result.body.equipment.rows.find(row=>row.championId==='DA_18_ElderDragon');
  assert.ok(dragon);assert.equal(dragon.stats.sampleSize,103);assert.equal(dragon.stats.avgPlacement,2.85);
  assert.ok(result.body.teammates.rows.some(row=>row.championId==='DA_18_ElderDragon'&&row.stats.sampleSize===103));
  assert.equal(result.body.comps.status,'not_supported');assert.equal(result.body.coverage.jointMatchQueries,false);
});

test('glossary HTTP exposes original general definitions without claiming a game patch', async () => {
  const response = await fetch(`${base}/api/glossary`);
  assert.equal(response.status, 200);
  const glossary = await response.json();
  assert.equal(glossary.schemaVersion, 1);
  assert.ok(glossary.entries.length >= 30);
  for (const entry of glossary.entries) {
    assert.equal(entry.scope, 'general');
    assert.equal(entry.sourcePatch, null);
    assert.ok(entry.definition && entry.term && entry.id);
    assert.ok(Array.isArray(entry.examples));
    assert.ok(Array.isArray(entry.misconceptions));
  }
  assert.equal(new Set(glossary.entries.map(entry => entry.id)).size, glossary.entries.length);
  assert.ok(glossary.entries.some(entry => entry.term.includes('锁血')));
});

test('V3 library delivers Chinese native tables and exact augment conditions with compression and targeted queries',async()=>{
  const response=await fetch(`${base}/api/library`,{headers:{'Accept-Encoding':'gzip'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-encoding'),'gzip');
  const library=await response.json();assert.equal(library.status,'ready');assert.equal(library.coverage.documents,44);assert.equal(library.augmentRules.length,248);
  assert.equal((await fetch(`${base}/library.js`)).status,200);assert.equal((await fetch(`${base}/library.css`)).status,200);
  const facts=await(await fetch(`${base}/api/library?query=${encodeURIComponent('Trait Ladder 6个羁绊奖励')}`)).json();
  assert.deepEqual(facts.data[0].tables[0].rows.map(row=>row.probability),[.5,.5]);
});

test('V2 homepage delivers ten observed comps and keeps missing source positions empty', async () => {
  const response = await fetch(`${base}/api/comps`);
  assert.equal(response.status,200);
  const result = await response.json();
  assert.equal(result.version,'2.0.0');
  assert.equal(result.delivery,'version_cache');
  assert.equal(result.data.length,10);
  assert.equal(result.coverage.code,10);
  assert.equal(result.coverage.positionComplete,8);
  assert.equal(result.context.set,catalog.context.set);
  for (const comp of result.data) {
    assert.ok(comp.stats.sampleSize >= 100);
    assert.match(comp.evidence.recordHash,/^[a-f0-9]{64}$/);
    assert.equal(comp.population.finalLevel,null);
    if (!comp.positionCoverage.placed) assert.ok(comp.units.every(unit=>unit.cell===null));
    for (const related of comp.variants) {
      const independent = result.data.find(row=>row.id===related.id);
      assert.ok(independent);
      assert.deepEqual(related.stats,independent.stats);
      assert.deepEqual(related.units,independent.units);
      assert.equal(related.relation.sourceFamilyVerified,false);
    }
  }
});

test('PC codes decode only the roster; separately cached source layout and round-trip are explicit', async () => {
  const comps = await (await fetch(`${base}/api/comps`)).json();
  const source = comps.data[0];
  const decoded=await post('/api/team-code/decode',{code:source.teamCode});
  assert.equal(decoded.status,200);
  assert.equal(decoded.body.units.length,source.units.length);
  assert.equal(decoded.body.includes.positions,false);
  assert.equal(decoded.body.includes.items,false);
  assert.ok(decoded.body.units.every(unit=>unit.cell===null && unit.items.length===0));
  assert.equal(decoded.body.sourceLayout.notEncodedInCode,true);
  assert.equal(decoded.body.sourceLayout.source.id,source.id);
  const encoded=await post('/api/team-code/encode',{units:decoded.body.units});
  assert.equal(encoded.status,200);
  assert.equal(encoded.body.code,source.teamCode);
  const invalid=await post('/api/team-code/decode',{code:'not-a-tft-code'});
  assert.equal(invalid.status,400);
  assert.equal(invalid.body.code,'invalid_code');
  const mismatch=await post('/api/team-code/decode',{code:source.teamCode.replace('TFTSet18','TFTSet17')});
  assert.equal(mismatch.status,400);
  assert.equal(mismatch.body.code,'set_mismatch');
});

test('V2 modules are served while internal data and secrets remain inaccessible', async () => {
  for (const path of ['/comps.js','/team-planner.js','/team-notes.js','/lineup-model.js','/tft-board.css','/team-planner.css']) {
    assert.equal((await fetch(`${base}${path}`)).status,200,path);
  }
  for (const path of ['/.env','/data/team-codes/raw/capture.json']) {
    assert.equal((await fetch(`${base}${path}`)).status,404,path);
  }
});

test('season mechanics API returns version-isolated cached facts with expert ratings separate from statistics', async () => {
  const response = await fetch(`${base}/api/mechanics`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.delivery, 'version_cache');
  assert.equal(result.context.set, catalog.context.set);
  assert.equal(result.context.assetVersion, catalog.context.assetVersion);
  assert.ok(Array.isArray(result.entries));
  assert.equal(new Set(result.entries.map(entry => entry.id)).size, result.entries.length);
  if (result.status === 'cached') {
    assert.equal(result.mechanic.id, 'wisps');
    assert.ok(result.entries.length > 0);
    for (const entry of result.entries) {
      assert.ok(!entry.rating?.tier || ['S', 'A', 'B', 'C', 'D'].includes(entry.rating.tier));
      assert.equal(entry.stats, undefined, 'mechanic rules and expert tiers are not observed match statistics');
      if (entry.rating?.tier) {
        assert.equal(entry.rating.sourceKind, 'expert');
        assert.equal(entry.upgrade?.variant, 'base', 'upgraded and prismatic variants must not inherit a base tier');
      }
    }
  } else assert.equal(result.status, 'not_cached');
});

test('mechanic offering rules join exact current entities without changing effect metadata', async () => {
  const response = await fetch(`${base}/api/mechanics`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.offering.status, 'cached', 'sync current offering conditions before integration tests');
  assert.equal(result.offering.cacheKey, result.cacheKey);
  assert.equal(result.offering.context.assetVersion, catalog.context.assetVersion);
  const conditions = result.entries.map(entry => entry.offeringConditions);
  assert.ok(conditions.every(Boolean));
  assert.equal(conditions.filter(entry => entry.sourceIdentityVerified).length, result.offering.coverage.mapped);
  assert.equal(conditions.filter(entry => entry.status === 'not_documented').length, result.offering.coverage.missing);
  const critical = result.entries.find(entry => entry.id === 'DA_18_Supercritical');
  assert.ok(critical.offeringConditions.allOf.some(rule => rule.field === 'abilityCritChampionCount' && rule.op === 'gte' && rule.value === 2 && rule.scope === 'army_any_location'));
  assert.equal(critical.offeringConditions.cooldown.unit, 'wisp_shops');
  assert.equal(critical.offeringConditions.cooldown.trigger, 'offered');
  assert.equal(critical.offeringConditions.probability.value, null);
  assert.equal(critical.offeringConditions.offerConditions.eligibilityGuaranteed, false);
  assert.equal(critical.source.descriptionSource.sourcePatch, null, '18.4 belongs to the offering source, not the effect source');
  assert.ok(critical.offeringConditions.sources.some(source => source.sourcePatch === '18.4'));
});

function actualDraft() {
  const parts = catalog.items.filter(item => item.kind === 'component');
  const completed = catalog.items.filter(item => item.kind === 'completed' && item.recipeVerified);
  return { version: 7,
    units: [
      { instanceId: 'carry-instance', championId: catalog.champions[0].id, role: 'carry', priority: 5, lockedItems: [completed[0].id] },
      { instanceId: 'tank-instance', championId: catalog.champions[1].id, role: 'tank', priority: 4, lockedItems: [] },
    ],
    components: Object.fromEntries(parts.map(item => [item.id, 3])),
    completedItems: { [completed[0].id]: 1, [completed[1].id]: 1 },
    reserve: { [parts[0].id]: 1 }, preferences: { 'carry-instance': [completed[1].id] },
  };
}

test('statistics overview exposes the same versioned knowledge base and only supported statistics', async () => {
  const response = await fetch(`${base}/api/stats`);
  assert.equal(response.status, 200);
  const overview = await response.json();
  assert.equal(overview.delivery, 'version_cache');
  assert.equal(overview.context.rulesVersion, catalog.context.rulesVersion);
  assert.equal(overview.context.assetVersion, catalog.context.assetVersion);
  assert.equal(overview.champions.length, catalog.champions.length);
  assert.equal(overview.items.length, catalog.items.filter(item => item.kind !== 'component').length);
  assert.equal(overview.coverage.emblemHolders.total, catalog.items.filter(item => item.category === 'emblem').length);
  assert.ok(overview.coverage.emblemHolders.cached <= overview.coverage.emblemHolders.total);
  assert.equal(overview.capabilities.augmentStats, false);
  assert.equal(overview.capabilities.championOverallStats, overview.coverage.overallStats.status === 'live');
  assert.equal(overview.capabilities.itemOverallStats, overview.coverage.overallStats.status === 'live');
  assert.equal(overview.capabilities.rankRegionFilters, false);
  const traitResponse = await fetch(`${base}/api/stats/traits`);
  assert.equal(traitResponse.status, 200);
  const traits = await traitResponse.json();
  assert.equal(traits.delivery, 'version_cache');
  assert.equal(traits.cacheKey, overview.cacheKey);
  assert.equal(traits.evidence.source, 'Tactics.tools');
  assert.equal(overview.capabilities.traitStats, traits.status === 'live');
  if (traits.status === 'live') {
    assert.match(traits.evidence.gamePatch, /^\d+\.\d+[a-z]?$/);
    assert.equal(traits.evidence.population.rank, 'Diamond+');
    assert.equal(traits.evidence.population.queue, 'Ranked');
    for (const row of traits.data) {
      const trait = catalog.traits.find(trait => trait.id === row.traitId);
      assert.ok(trait?.effects.some(effect => effect.minUnits === row.minUnits));
      assert.ok(row.stats.top4Rate >= 0 && row.stats.top4Rate <= 1);
      assert.ok(row.stats.winRate >= 0 && row.stats.winRate <= 1);
    }
  }
  const unknown = await (await fetch(`${base}/api/champions/not-current-set/build`)).json();
  assert.equal(unknown.status, 'unavailable');
  assert.deepEqual(unknown.data, []);
});

test('explorer HTTP delivers compressed local records without inventing joint statistics', async () => {
  const response = await fetch(`${base}/api/explorer?tab=champions`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  const result = await response.json();
  assert.equal(result.delivery, 'version_cache');
  assert.equal(result.context.set, catalog.context.set);
  assert.equal(result.capabilities.jointMatchQueries, false);
  assert.equal(result.summary.sampleSize, null);
  assert.ok(Array.isArray(result.rows));
  const invalid = await fetch(`${base}/api/explorer?tab=region`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'INVALID_EXPLORER_TAB');
});

test('developer assets and documents expose local knowledge only, with bounded document browsing', async () => {
  const overviewResponse = await fetch(`${base}/api/developer/overview`);
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json();
  assert.equal(overview.storage.engine, 'local_json');
  assert.equal(overview.current.context.set, catalog.context.set);
  const mapping = overview.assets.find(asset=>asset.family==='teamcodes' && asset.status==='ready');
  assert.ok(mapping,'current PC mapping must be visible in developer assets');
  assert.equal(mapping.counts.mappedChampions,65);
  assert.equal(mapping.counts.unmappedChampions,9);
  assert.equal(mapping.retrievalEligibility.eligible,false);
  assert.deepEqual(mapping.retrievalEligibility.tools,[]);
  for (const service of ['mysql', 'milvus', 'redis']) assert.equal(overview.storage[service].status, 'not_connected');
  for (const operation of ['publish', 'rollback', 'rebuild']) assert.equal(overview.operations[operation].enabled, false);
  const documentsResponse = await fetch(`${base}/api/developer/documents?limit=2`);
  assert.equal(documentsResponse.status, 200);
  const documents = await documentsResponse.json();
  assert.ok(documents.documents.length > 0 && documents.documents.length <= 2);
  const documentResponse = await fetch(`${base}/api/developer/document?id=${encodeURIComponent(documents.documents[0].id)}`);
  assert.equal(documentResponse.status, 200);
  const document = await documentResponse.json();
  assert.equal(document.id, documents.documents[0].id);
  assert.ok(document.fingerprint);
  assert.ok(Array.isArray(document.chunks));
  const outside = await fetch(`${base}/api/developer/document?id=${encodeURIComponent('../../.env')}`);
  assert.equal(outside.status, 404);
  const staticModule = await fetch(`${base}/developer.js`);
  assert.equal(staticModule.status, 200);
  assert.match(staticModule.headers.get('content-type'), /javascript/);
  const releases = await (await fetch(`${base}/api/developer/releases`)).json();
  const validStats = releases.releases.filter(release => release.family === 'stats' && release.validation.valid && release.validation.checksumVerified);
  const currentStats = validStats.find(release => release.active);
  const previousStats = validStats.find(release => !release.active);
  assert.ok(currentStats && previousStats, 'real retained statistics must supply the diff baseline');
  const diff = await post('/api/developer/diff', { from: previousStats.id, to: currentStats.id });
  assert.equal(diff.status, 200);
  assert.equal(diff.body.status, 'ready');
  assert.equal(diff.body.previewOnly, true);
  assert.equal(diff.body.rollback.executable, false);
  assert.ok(Number.isSafeInteger(diff.body.changes.added));
  const pathDiff = await post('/api/developer/diff', { from: '../../.env', to: currentStats.id });
  assert.equal(pathDiff.body.status, 'invalid_selection');
});

test('developer retrieval preview records actual prefetch without invoking the paid model', async () => {
  const before = await (await fetch(`${base}/api/health`)).json();
  const preview = await post('/api/developer/retrieval', { question: '大树最佳阵容和三件装备是什么？' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.mode, 'prefetch_preview');
  assert.ok(preview.body.traceId);
  assert.ok(Array.isArray(preview.body.tools) && preview.body.tools.length > 0);
  assert.ok(Array.isArray(preview.body.modelContext) && preview.body.modelContext.length > 0);
  const detailResponse = await fetch(`${base}/api/developer/trace?id=${encodeURIComponent(preview.body.traceId)}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.id, preview.body.traceId);
  assert.equal(detail.mode, 'prefetch_preview');
  assert.deepEqual(detail.modelInputs, []);
  assert.equal(detail.cache.redis.status, 'not_connected');
  const serialized = JSON.stringify(detail);
  assert.doesNotMatch(serialized, /"systemPrompt"|"authorization"|"AI_API_KEY"/i);
  const after = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(after.ai, before.ai);
  const traces = await (await fetch(`${base}/api/developer/traces`)).json();
  assert.ok(traces.traces.some(trace => trace.id === preview.body.traceId));
  const mismatch = await post('/api/developer/retrieval', { question: '大树装备', context: { set: 999 } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, 'DEBUG_VERSION_MISMATCH');
  assert.ok(mismatch.body.traceId);
});

test('developer HTTP grants no publish, rollback or rebuild authority and retains local-only access', async () => {
  for (const operation of ['publish', 'rollback', 'rebuild']) {
    const denied = await post(`/api/developer/${operation}`, {});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'DEVELOPER_READONLY');
  }
  const foreign = await fetch(`${base}/api/developer/overview`, { headers: { Origin: 'https://example.org' } });
  assert.equal(foreign.status, 403);
  const wrongMethod = await fetch(`${base}/api/developer/overview`, { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  const missing = await fetch(`${base}/api/developer/trace?id=not-a-record`);
  assert.equal(missing.status, 404);
});

test('real catalog plan API preserves slots, locks, unique restrictions and independently counted resources', async () => {
  const draft = actualDraft();
  const unknownSpecial = catalog.items.find(item => item.kind === 'special' && item.allocationVerified === false);
  assert.ok(unknownSpecial, 'current source catalog must explicitly mark unverified special compatibility');
  draft.completedItems[unknownSpecial.id] = 1;
  draft.preferences['carry-instance'].unshift(unknownSpecial.id);
  const result = await post('/api/plan', { draft });
  assert.equal(result.status, 200);
  const plan = result.body.plan;
  assert.equal(plan.draftVersion, draft.version);
  assert.equal(plan.feasible, true);
  assert.equal(plan.usedCompletedItems[unknownSpecial.id] ?? 0, 0);
  assert.equal(plan.remainingCompletedItems[unknownSpecial.id], 1);
  assert.equal(plan.assignments.some(assignment => assignment.items.some(item => item.itemId === unknownSpecial.id)), false);
  assert.ok(plan.warnings.some(message => message.includes(unknownSpecial.name) && message.includes('兼容性未核验')));
  const byId = new Map(catalog.items.map(item => [item.id, item]));
  const componentSpend = {};
  const inventorySpend = {};
  for (const assignment of plan.assignments) {
    assert.ok(assignment.items.length <= 3);
    assert.ok(assignment.items.reduce((sum, item) => sum + (byId.get(item.itemId)?.slotCost ?? 1), 0) <= 3);
    const source = draft.units.find(unit => unit.instanceId === assignment.instanceId);
    assert.deepEqual(assignment.items.filter(item => item.origin === 'locked').map(item => item.itemId), source.lockedItems);
    for (const item of assignment.items) {
      const entity = byId.get(item.itemId);
      assert.ok(entity);
      if (entity.unique) assert.equal(assignment.items.filter(value => value.itemId === item.itemId).length, 1);
      if (item.origin === 'crafted') {
        assert.equal(entity.kind, 'completed');
        assert.equal(entity.recipeVerified, true);
        assert.equal(entity.components.length, 2);
        for (const id of entity.components) componentSpend[id] = (componentSpend[id] ?? 0) + 1;
      }
      if (item.origin === 'inventory') inventorySpend[item.itemId] = (inventorySpend[item.itemId] ?? 0) + 1;
    }
  }
  for (const [id, quantity] of Object.entries(draft.components)) {
    assert.equal((componentSpend[id] ?? 0) + plan.remainingComponents[id], quantity);
    assert.equal(plan.usedComponents[id] ?? 0, componentSpend[id] ?? 0);
    assert.ok(plan.remainingComponents[id] >= (draft.reserve[id] ?? 0));
  }
  for (const [id, quantity] of Object.entries(draft.completedItems)) {
    assert.equal((inventorySpend[id] ?? 0) + plan.remainingCompletedItems[id], quantity);
    assert.equal(plan.usedCompletedItems[id] ?? 0, inventorySpend[id] ?? 0);
  }
  const validation = await post('/api/plan/validate', { draft, plan });
  assert.equal(validation.status, 200);
  assert.equal(validation.body.valid, true);
  const stale = await post('/api/plan/validate', { draft: { ...draft, version: draft.version + 1 }, plan });
  assert.equal(stale.body.valid, false);
  assert.ok(stale.body.errors.some(error => error.code === 'STALE_PLAN'));
  const changed = structuredClone(plan);
  const componentId = Object.keys(draft.components)[0];
  changed.remainingComponents[componentId] = 99;
  const tampered = await post('/api/plan/validate', { draft, plan: changed });
  assert.equal(tampered.body.valid, false);
  assert.ok(tampered.body.errors.some(error => error.code === 'LEDGER_MISMATCH'));
});

test('draft size and bad inventories are rejected at the API boundary as 400', async () => {
  const draft = actualDraft();
  const id = Object.keys(draft.components)[0];
  for (const quantity of [-1, 1.5, 100]) {
    const response = await post('/api/plan', { draft: { ...draft, components: { ...draft.components, [id]: quantity } } });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_QUANTITY');
  }
  const tooMany = Array.from({ length: 33 }, (_, index) => ({ ...draft.units[0], instanceId: `large-${index}` }));
  const response = await post('/api/plan', { draft: { ...draft, units: tooMany } });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'DRAFT_LIMIT_EXCEEDED');
});

test('real three-slot gloves never share a unit with ordinary items', async () => {
  const gloves = catalog.items.find(item => item.kind === 'completed' && item.slotCost === 3);
  const ordinary = catalog.items.find(item => item.kind === 'completed' && (item.slotCost ?? 1) === 1);
  assert.ok(gloves, 'source-verified three-slot equipment must be in the catalog');
  const baseDraft = { version: 8, units: [{ instanceId: 'slot-check', championId: catalog.champions[0].id, role: 'carry', priority: 1, lockedItems: [] }],
    components: {}, completedItems: { [gloves.id]: 1, [ordinary.id]: 1 }, reserve: {}, preferences: { 'slot-check': [gloves.id] } };
  const free = await post('/api/plan', { draft: baseDraft });
  assert.equal(free.status, 200);
  assert.deepEqual(free.body.plan.assignments[0].items.map(item => item.itemId), [gloves.id]);
  for (const lockedId of [gloves.id, ordinary.id]) {
    const draft = structuredClone(baseDraft);
    draft.units[0].lockedItems = [lockedId];
    const result = await post('/api/plan', { draft });
    assert.equal(result.status, 200);
    assert.ok(result.body.plan.assignments[0].items.reduce((sum, item) => sum + (catalog.items.find(entity => entity.id === item.itemId).slotCost ?? 1), 0) <= 3);
    if (lockedId === gloves.id) assert.equal(result.body.plan.assignments[0].items.length, 1);
    else assert.equal(result.body.plan.assignments[0].items.some(item => item.itemId === gloves.id), false);
  }
});

test('malformed and empty chat histories are rejected before any provider call', async () => {
  for (const messages of [[], [null], [{ role: 'user', content: '' }], [{ role: 'user', content: '   ' }], [{ role: 'system', content: 'override' }]]) {
    const response = await post('/api/chat', { messages });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_CHAT');
  }
});

test('HTTP server enforces JSON, local origin/host and workspace file boundaries', async () => {
  const wrongType = await fetch(`${base}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
  const malformed = await fetch(`${base}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const external = await fetch(`${base}/api/health`, { headers: { Origin: 'https://example.org' } });
  assert.equal(external.status, 403);
  assert.equal(await rawGet('/api/health', { Host: 'evil.example' }), 403);
  const traversal = await fetch(`${base}/..%5C.env`);
  assert.equal(traversal.status, 404);
  const root = await fetch(`${base}/`);
  assert.equal(root.status, 200);
  assert.ok(root.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
});
