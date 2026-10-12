import { sha256, stableJSON } from '../../scripts/stats-cache.mjs';
import { getActiveRelease } from '../storage/repository.mjs';
import { isDatabaseMode } from '../storage/runtime.mjs';
import { getMetaTftMetadata, readMetaTft, metaError } from './client.mjs';
import { findMetaSnapshot, saveMetaSnapshot, selectMetaRows } from './repository.mjs';
import { rankLabel, scopeRank } from '../../public/stat-ranks.js';
import { metaScope, metaParams } from './scope.mjs';

const inFlight = new Map();
const counts = values => values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map());
const validId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
export function metaStats(placementCount) {
  if (!Array.isArray(placementCount) || placementCount.length !== 8 || placementCount.some(n => !Number.isSafeInteger(n) || n < 0)) throw metaError('MetaTFT 名次数据格式改变，未将异常数据当成零样本。', 'METATFT_RESPONSE_INVALID');
  const sampleSize = placementCount.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(sampleSize)) throw metaError('MetaTFT 样本数超出范围。', 'METATFT_RESPONSE_INVALID');
  return { sampleSize, avgPlacement: sampleSize ? placementCount.reduce((sum, n, i) => sum + n * (i + 1), 0) / sampleSize : null,
    top4Rate: sampleSize ? placementCount.slice(0, 4).reduce((a, b) => a + b, 0) / sampleSize : null, winRate: sampleSize ? placementCount[0] / sampleSize : null };
}

export function metaPlan(query, release, metadata) {
  const commonScope = metaScope(release, metadata, query);
  if (!query.conditions.length) throw metaError('请先添加棋子或装备条件。', 'INVALID_RESEARCH_QUERY', 400);
  if (query.conditions.some(term => term.type === 'trait')) throw metaError('MetaTFT 当前接入支持棋子、成装及佩戴者组合，请先移除羁绊条件。', 'METATFT_CONDITION_UNSUPPORTED', 400);
  if (query.conditions.some(term => !validId(term.id) || term.holderId && !validId(term.holderId))) throw metaError('条件中的实体 ID 无效。', 'INVALID_RESEARCH_QUERY', 400);
  const conditions = query.conditions.slice().sort((a, b) => stableJSON(a).localeCompare(stableJSON(b)));
  const heroes = [...new Set(conditions.filter(term => term.type === 'champion').map(term => term.id))];
  const items = conditions.filter(term => term.type === 'item');
  const carrier = query.carrierId || heroes[0] || null;
  const focusItem = items[0]?.id || null;
  const scope = { adapterVersion: 2, conditions, carrierId: carrier, focusItemId: focusItem, ...commonScope };
  const params = metaParams(scope);
  for (const hero of heroes) params.append('unit_unique', `${hero}-1`);
  // Every condition consumes a copy, including an unbound copy beside bound copies.
  for (const [id, count] of counts(items.map(term => term.id))) params.append('item_unique', `${id}-${count}`);
  for (const holder of new Set(items.map(term => term.holderId).filter(Boolean))) {
    for (const [id, count] of counts(items.filter(term => term.holderId === holder).map(term => term.id))) params.append('unit_item_unique', `${holder}-1&${id}-${count}`);
  }
  const paths = { total: 'total', equipment: carrier ? `unit_builds/${carrier}` : `unit_builds/any_unit/${focusItem}`,
    teammates: heroes.length ? 'units_unique' : `item_units_unique/${focusItem}-1`, comps: 'exact_units_traits2' };
  return { scope, paths, holders: !heroes.length, urls: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, `/tft-explorer-api/${path}?${params}`])),
    queryKey: sha256(stableJSON({ releaseId: release.id, ...scope })) };
}

function checkedData(response, plan) {
  const data = response.data;
  if (!Array.isArray(data?.data) || data.data.length > 20000 || data.filter_adjustment?.override_applied !== false
    || String(data.filter_adjustment.rank_filter).split(',').sort().join(',') !== plan.scope.ranks.join(',')) throw metaError('MetaTFT 返回的查询范围或格式与请求不一致，未扩大条件展示结果。', 'METATFT_SCOPE_CHANGED');
  for (const row of data.data) metaStats(row.placement_count);
  return data.data;
}

export function normalizeMetaRows(dimension, raw, plan, catalog) {
  const result = [], selected = new Set(plan.scope.conditions.filter(term => term.type === 'champion').map(term => term.id));
  const required = counts(plan.scope.conditions.filter(term => term.type === 'item' && term.holderId === plan.scope.carrierId).map(term => term.id));
  const seen = new Set();
  for (const source of raw) {
    const stats = metaStats(source.placement_count);
    if (!stats.sampleSize) continue;
    let row, sourceKey;
    if (dimension === 'equipment') {
      sourceKey = source.unit_builds;
      if (typeof sourceKey !== 'string' || sourceKey.split('&').length !== 2) throw metaError('MetaTFT 出装格式已改变。', 'METATFT_RESPONSE_INVALID');
      const [championId, build] = sourceKey.split('&'), itemIds = build.split('|');
      if (!validId(championId) || itemIds.some(id => !validId(id))) throw metaError('MetaTFT 出装实体无效。', 'METATFT_RESPONSE_INVALID');
      if (itemIds.length !== 3 || plan.scope.carrierId && championId !== plan.scope.carrierId) continue;
      if (!plan.scope.carrierId && !itemIds.includes(plan.scope.focusItemId)) continue;
      if ([...required].some(([id, n]) => (counts(itemIds).get(id) || 0) < n)) continue;
      row = { championId, itemIds };
    } else if (dimension === 'teammates') {
      sourceKey = plan.holders ? source.unit_items_unique : source.units_unique;
      if (typeof sourceKey !== 'string') throw metaError('MetaTFT 棋子格式已改变。', 'METATFT_RESPONSE_INVALID');
      const match = sourceKey.match(/^([A-Za-z][A-Za-z0-9_]*)-(\d+)(?:&([A-Za-z][A-Za-z0-9_]*)-(\d+))?$/);
      if (!match) throw metaError('MetaTFT 棋子序号无效。', 'METATFT_RESPONSE_INVALID');
      // Higher occurrence rows overlap with the first copy; never sum them or call them star levels.
      if (match[2] !== '1' || selected.has(match[1]) || plan.holders && (match[3] !== plan.scope.focusItemId || match[4] !== '1')) continue;
      row = { championId: match[1], unitOccurrence: 1, ...(plan.holders ? { heldItemId: match[3] } : {}) };
    } else {
      sourceKey = source.units_traits;
      if (typeof sourceKey !== 'string' || !sourceKey.includes('|')) throw metaError('MetaTFT 阵容格式已改变。', 'METATFT_RESPONSE_INVALID');
      const ids = sourceKey.split('|')[0].split('&');
      if (ids.some(id => !validId(id)) || [...selected].some(id => !ids.includes(id))) throw metaError('MetaTFT 阵容不满足已选棋子条件。', 'METATFT_SCOPE_CHANGED');
      const units = ids.map(id => ({ championId: id, items: [], name: catalog.champions.find(champion => champion.id === id)?.name || id }));
      row = { units, name: units.map(unit => unit.name).join(' · '), traits: [], sourceTraitKey: sourceKey.split('|').slice(1).join('|') };
    }
    const rowKey = sha256(sourceKey);
    if (seen.has(rowKey)) throw metaError('MetaTFT 返回重复统计行，未累加样本。', 'METATFT_RESPONSE_INVALID');
    seen.add(rowKey);
    result.push({ ...row, dimension, rowKey, id: `metatft:${dimension}:${rowKey}`, stats, placementCount: source.placement_count, sourceKey });
  }
  return result;
}

async function collectSnapshot(query, release, metadata, plan, catalog, deps) {
  const read = deps.readMetaTft || readMetaTft;
  const responses = { total: await read(plan.urls.total) };
  const totals = checkedData(responses.total, plan);
  if (totals.length > 1) throw metaError('MetaTFT 汇总格式已改变。', 'METATFT_RESPONSE_INVALID');
  const stats = metaStats(totals[0]?.placement_count || [0,0,0,0,0,0,0,0]);
  const rows = [], sourceRows = {};
  if (stats.sampleSize) {
    const columns = await Promise.all(['equipment', 'teammates', 'comps'].map(async dimension => {
      const response = await read(plan.urls[dimension]), raw = checkedData(response, plan);
      return { dimension, response, raw, normalized: normalizeMetaRows(dimension, raw, plan, catalog) };
    }));
    for (const column of columns) { responses[column.dimension] = column.response; sourceRows[column.dimension] = column.raw.length; rows.push(...column.normalized); }
  }
  // Keep byte-verifiable bodies outside MySQL JSON: its floating-point serialization
  // can change the last decimal digit, even though displayed metrics are unaffected.
  const rawResponseText = stableJSON(Object.fromEntries(Object.entries(responses).map(([key, {data, ...record}]) => [key, record])));
  const structured = Object.fromEntries(Object.entries(responses).map(([key, {bodyText, ...record}]) => [key, record]));
  const capturedAt = Date.now(), contentHash = sha256(rawResponseText);
  const snapshot = { id: sha256(`${plan.queryKey}:${contentHash}:${capturedAt}`), queryKey: plan.queryKey, release, scope: plan.scope, metadata, responses: structured, rawResponseText, rows, contentHash, capturedAt, expiresAt: capturedAt + 10 * 60 * 1000,
    summary: { stats, holders: plan.holders, sourceRows, exhaustive: false, responsePatch: null } };
  await (deps.saveMetaSnapshot || saveMetaSnapshot)(snapshot);
  return snapshot;
}

export async function getMetaTftResearchResults(query, catalog, deps = {}) {
  if (!(deps.databaseMode ?? isDatabaseMode())) throw metaError('MetaTFT 筛选器需要连接 MySQL，请使用已部署的数据库服务。', 'DATABASE_REQUIRED');
  const release = await (deps.getActiveRelease || getActiveRelease)();
  if (!release) throw metaError('当前数据库没有已发布资料。', 'DATA_NOT_IMPORTED');
  const metadata = await (deps.getMetaTftMetadata || getMetaTftMetadata)();
  const plan = metaPlan(query, release, metadata);
  let snapshot = await (deps.findMetaSnapshot || findMetaSnapshot)(release.id, plan.queryKey), cacheHit = Boolean(snapshot);
  if (!snapshot) {
    if (!inFlight.has(plan.queryKey)) inFlight.set(plan.queryKey, collectSnapshot(query, release, metadata, plan, catalog, deps).finally(() => inFlight.delete(plan.queryKey)));
    snapshot = await inFlight.get(plan.queryKey);
  }
  // Always read the persisted rows, including on the first upstream collection.
  const columns = await (deps.selectMetaRows || selectMetaRows)(snapshot.id, query);
  const evidence = { source: 'MetaTFT Explorer', url: 'https://www.metatft.com/explorer', delivery: 'mysql', releaseId: release.id, snapshotId: snapshot.id,
    sourcePatch: null, requestedPatch: `${snapshot.scope.patch}${snapshot.scope.bPatch}`, sourceCurrentPatch: `${snapshot.metadata.patch.patch}${snapshot.metadata.patch.b_patch_version || ''}`,
    patchAttribution: { method: 'explicit_request_and_source_metadata', statisticsResponsePatch: null },
    set: snapshot.scope.season, queueId: 1100, rank: rankLabel(scopeRank(snapshot.scope.ranks)), rankFilter: scopeRank(snapshot.scope.ranks), population: 'MetaTFT 默认地区范围 · 普通排位 · 近 3 天',
    sampleDenominator: '来源按玩家名次聚合的观测数；未取得独立比赛 ID，不同组合可能重叠。', statisticalWindow: { days: 3, timeAnchor: 'source_relative_window' }, fetchedAt: new Date(snapshot.capturedAt).toISOString() };
  const total = snapshot.summary.stats.sampleSize, status = total ? 'ok' : 'empty';
  const labels = { equipment: plan.scope.carrierId ? '该棋子的三件套 · 同时满足全部阵容条件' : '所选装备的三件套 · 同时满足全部阵容条件',
    teammates: plan.holders ? `${catalog.items.find(item => item.id === plan.scope.focusItemId)?.name || plan.scope.focusItemId}的持有棋子 · 同时满足全部条件` : '同时满足全部条件的阵容中的队友', comps: '同时满足全部条件的棋子组合' };
  const column = dimension => { const data = columns[dimension]; return { ...data, evidence, label: labels[dimension], status: data.count ? 'ok' : data.beforeMinimum ? 'insufficient_samples' : 'empty',
    reason: data.count ? null : !total ? 'MetaTFT 当前范围内没有同时满足全部条件的样本。' : data.beforeMinimum ? '已有对应统计，但没有达到当前最低样本数；可降低样本门槛。' : '来源返回的候选中没有这类匹配记录。',
    sourceReturnedRows: snapshot.summary.sourceRows[dimension] ?? 0, exhaustive: false, rows: data.rows.map(row => ({ ...row, evidence })) }; };
  return { schemaVersion: 3, query, source: 'metatft', delivery: 'mysql', status, stats: { ...snapshot.summary.stats }, reason: total ? null : '没有满足全部条件的样本，未放宽条件或改用其他来源。', evidence,
    querySemantics: 'source_aggregate_same_board_conditions', jointMatchQueries: false, jointConditions: true,
    equipment: { ...column('equipment'), kind: 'observed_builds' }, teammates: { ...column('teammates'), kind: plan.holders ? 'item_holders' : 'joint_teammates' }, comps: column('comps'),
    coverage: { jointMatchQueries: false, jointConditions: true, matchedSamples: total, matchedMatches: null, scope: snapshot.scope, snapshotId: snapshot.id, cacheHit, expiresAt: new Date(snapshot.expiresAt).toISOString(), sourceRows: snapshot.summary.sourceRows, exhaustive: false },
    note: '全部条件在同一阵容中同时成立；指定佩戴者的装备绑定该棋子，任意英雄携带的装备可以分布在不同棋子上。指标从来源名次分布计算，MySQL 保存完整条件与快照。仅排序来源返回的候选，来源可能截断结果，不代表全量最优；样本数不是独立比赛场数。',
  };
}
