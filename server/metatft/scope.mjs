import { rankScope, rankLabel, scopeRank, DEFAULT_RANK } from '../../public/stat-ranks.js';
import { metaError } from './client.mjs';

export const META_RANKS = ['CHALLENGER', 'DIAMOND', 'EMERALD', 'GRANDMASTER', 'MASTER', 'PLATINUM'];
export function metaScope(release, metadata, options = {}) {
  if (metadata.set !== `TFTSet${release.season}` || metadata.patch?.patch !== release.currentPatch || !/^\d+\.\d+$/.test(metadata.patch.patch) || !/^[a-z]*$/.test(metadata.patch.b_patch_version ?? '')) throw metaError('MetaTFT 当前赛季或补丁与本项目资料不同，请更新资料后重试。', 'METATFT_VERSION_MISMATCH');
  return { season: release.season, patch: metadata.patch.patch, bPatch: metadata.patch.b_patch_version ?? '', queue: 1100, days: 3, ranks: rankScope(options.rank ?? DEFAULT_RANK), server: null };
}
export function metaParams(scope) {
  return new URLSearchParams({ formatnoarray: 'true', compact: 'true', queue: String(scope.queue), patch: scope.patch, b_patch: scope.bPatch, days: String(scope.days), rank: scope.ranks.join(','), permit_filter_adjustment: 'true' });
}
export function checkMetaScope(data, scope) {
  if (data?.filter_adjustment?.override_applied !== false || String(data.filter_adjustment.rank_filter).split(',').sort().join(',') !== scope.ranks.join(',')) throw metaError('MetaTFT 返回的查询范围与请求不一致，未扩大条件展示结果。', 'METATFT_SCOPE_CHANGED');
}
export function metaEvidence(snapshot, source = 'MetaTFT Explorer') {
  const { scope, metadata } = snapshot;
  return { source, url: source === 'MetaTFT Comps' ? 'https://www.metatft.com/comps' : 'https://www.metatft.com/explorer', delivery: 'mysql', releaseId: snapshot.releaseId || snapshot.release.id,
    snapshotId: snapshot.id, recordHash: snapshot.contentHash, sourcePatch: null, requestedPatch: `${scope.patch}${scope.bPatch}`, sourceCurrentPatch: `${metadata.patch.patch}${metadata.patch.b_patch_version || ''}`,
    patchAttribution: { method: 'explicit_request_and_source_metadata', statisticsResponsePatch: null }, set: scope.season, queueId: scope.queue, queue: 'Ranked', rank: rankLabel(scopeRank(scope.ranks)), rankFilter: scopeRank(scope.ranks),
    population: { queue: 'Ranked', rank: rankLabel(scopeRank(scope.ranks)), rankFilter: scopeRank(scope.ranks), region: null }, statisticalWindow: { days: scope.days, timeAnchor: 'source_relative_window' },
    sampleDenominator: '来源按玩家最终名次聚合的观测数；不是独立比赛场数，重叠记录不相加。',
    fetchedAt: new Date(snapshot.capturedAt).toISOString(), expiresAt: new Date(snapshot.expiresAt).toISOString() };
}
