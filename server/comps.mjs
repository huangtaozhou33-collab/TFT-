import { getCatalog, getMetaDecks } from './data.mjs';
import { cacheContext } from '../scripts/stats-cache.mjs';
import { computeLineupPopulation } from '../public/lineup-model.js';

const copy = value => JSON.parse(JSON.stringify(value));
export function hasObservedCompStatistics(deck) {
  const stats = deck?.stats;
  const evidence = deck?.evidence;
  const effectivePatch = evidence?.sourcePatch || evidence?.effectivePatch;
  const persistedSource = evidence?.delivery === 'version_cache'
    || evidence?.delivery === 'mysql' && evidence?.statisticsKind === 'comp_cluster' && /^[a-f0-9]{64}$/.test(evidence.releaseId || '')
      && /^[a-f0-9]{64}$/.test(evidence.snapshotId || '') && /^\d+\.\d+[a-z]?$/.test(evidence.requestedPatch || '')
      && evidence.requestedPatch === evidence.sourceCurrentPatch && evidence.patchAttribution?.method === 'explicit_request_and_source_metadata'
    || evidence?.delivery === 'mysql' && /^[a-f0-9]{64}$/.test(evidence.releaseId || '')
      && typeof effectivePatch === 'string' && /^\d+\.\d+[a-z]?$/.test(effectivePatch)
      && effectivePatch === evidence.currentPatch
      && (Boolean(evidence.sourcePatch) || evidence.assignedPatch === effectivePatch && ['manual_calendar','source_page'].includes(evidence.patchAssignment?.method));
  return stats && Number.isSafeInteger(stats.sampleSize) && stats.sampleSize >= 100
    && Number.isFinite(stats.avgPlacement) && stats.avgPlacement >= 1 && stats.avgPlacement <= 8
    && ['winRate', 'top4Rate'].every(key => Number.isFinite(stats[key]) && stats[key] >= 0 && stats[key] <= 1)
    && stats.top4Rate >= stats.winRate && /^[a-f0-9]{64}$/.test(deck?.evidence?.recordHash || '')
    && persistedSource;
}
export function buildObservedRelatedComps(deck, candidates) {
  if (!hasObservedCompStatistics(deck)) return [];
  const ids = new Set(deck.units.map(unit => unit.id));
  const cores = new Set(deck.units.filter(unit => unit.isCore === true).map(unit => unit.id));
  return candidates.filter(other => other.id !== deck.id && hasObservedCompStatistics(other)).flatMap(other => {
    const sharedCoreIds = other.units.filter(unit => unit.isCore === true && cores.has(unit.id)).map(unit => unit.id);
    const sharedCount = new Set(other.units.filter(unit => ids.has(unit.id)).map(unit => unit.id)).size;
    const overlap = sharedCount / Math.min(ids.size, new Set(other.units.map(unit => unit.id)).size);
    if (!sharedCoreIds.length || overlap < 0.5) return [];
    return [{ ...copy(other), variants: [], relation: {
      kind: 'related_observed_comp', sharedCoreIds, sharedCount, rosterOverlap: overlap,
      sourceFamilyVerified: false,
      note: '独立完整来源阵容，保留它自己的统计；关联按共有核心与较小名单至少50%重叠生成。来源未将其标为同族变阵，不能推出换人后的胜率提升。',
    } }];
  }).sort((a,b) => a.stats.avgPlacement-b.stats.avgPlacement);
}
export async function getCompsOverview(options={}) {
  const [catalog, snapshot] = await Promise.all([getCatalog(), getMetaDecks(options)]);
  const meta = snapshot.evidence?.statisticsKind === 'comp_cluster';
  const known = new Set(catalog.champions.map(unit => unit.id));
  const candidates = (snapshot.data || []).filter(deck => Array.isArray(deck.units) && deck.units.length
    && deck.units.every(unit => known.has(unit.id)) && hasObservedCompStatistics(deck)).slice(0, meta ? 100 : 10);
  const data = candidates.map(deck => {
    const row = copy(deck), occupied = new Set(), warnings = [];
    row.units = row.units.map(unit => {
      let cell = unit.cell;
      if (cell != null) {
        const valid = Number.isSafeInteger(cell.x) && Number.isSafeInteger(cell.y) && cell.x >= 1 && cell.x <= 7 && cell.y >= 1 && cell.y <= 4 && !occupied.has(`${cell.x},${cell.y}`);
        if (valid) occupied.add(`${cell.x},${cell.y}`);
        else { warnings.push({ code: 'invalid_source_position', championId: unit.id, message: '来源坐标无效或重叠；保留棋子，未生成替代站位。' }); cell = null; }
      }
      return { ...unit, cell: cell ? { x: cell.x, y: cell.y } : null };
    });
    const placed = row.units.filter(unit => unit.cell).length;
    if (!placed) warnings.push({ code: 'source_position_missing', message: '此来源阵容没有站位坐标；棋子显示在未摆放区，可另存笔记后自行摆放。' });
    return { ...row, context: cacheContext(catalog), warnings,
      positionCoverage: { placed, total: row.units.length },
      population: { ...computeLineupPopulation(row.units, catalog), method: 'catalog_roster_slots' },
      coordinateSystem: meta ? {kind:'source_positions_not_provided',columns:7,rows:4} : { kind: 'opgg_source_xy', columns: 7, rows: 4, indexBase: 1, displayTopY: 4, frontRowY: 4,
        verification: { source: 'OP.GG public team-builder', url: 'https://op.gg/tft/tools/team-builder',
          mappingUrl: 'https://c-tft-web.op.gg/_next/static/chunks/5923-875d594a93cc412d.js', formula: 'row=4-y,col=x-1' } },
    };
  });
  return { status: data.length ? 'ready' : 'unavailable', version: '2.0.0', delivery: snapshot.delivery||snapshot.evidence?.delivery||'version_cache',
    context: cacheContext(catalog), evidence: snapshot.evidence, data: data.map(deck => ({ ...deck, variants: meta ? [] : buildObservedRelatedComps(deck, data) })),
    coverage: { displayed: data.length, target: meta ? snapshot.data.length : 10, sourceDecks: snapshot.data?.length || 0, code: data.filter(deck => deck.teamCode).length, positionComplete: data.filter(deck => deck.positionCoverage.placed === deck.units.length).length },
    capabilities: { pcTftOnly: true, arbitraryGeneratedVariants: false, observedRelatedComps: !meta, independentlyObservedEquipmentSwaps: false },
    reason:snapshot.reason||null,
    note: meta ? 'MetaTFT 阵容体系统计，包含该体系的不同变体。棋子与装备为来源代表配置，不代表固定三件套或站位的联合胜率。个人编辑不继承来源统计。' : '只读当前版本的真实来源阵容；均次、前四和登顶来自各自原始stat.deck，来源补丁、地区与段位缺失时保持未知。个人编辑不会继承这些统计。',
  };
}
