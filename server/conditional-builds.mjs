import { getCatalog, getChampionBuild } from './data.mjs';
import { validateBuildQuery, selectConditionalBuilds } from '../public/build-query.js';

export async function getConditionalChampionBuild(input, dependencies = {}) {
  const catalog = await (dependencies.getCatalog || getCatalog)();
  const validation = validateBuildQuery(input, catalog);
  if (!validation.valid) return { ...selectConditionalBuilds([], input, catalog), delivery: 'version_cache', evidence: null };
  const source = await (dependencies.getChampionBuild || getChampionBuild)(validation.query.championId, {rank:validation.query.rank});
  const selected = selectConditionalBuilds(source.data, validation.query, catalog);
  return { ...selected, schemaVersion: 1, delivery: source.delivery || 'version_cache',
    sourceStatus: source.status, evidence: source.evidence || null,
    champion: { id: validation.champion.id, name: validation.champion.name, icon: validation.champion.icon, cost: validation.champion.cost },
    ...(source.status !== 'live' && source.status !== 'cached' ? { status: source.status === 'empty' ? 'empty' : source.status === 'not_cached' ? 'not_cached' : 'unavailable', reason: source.reason || '当前英雄的出装统计尚未收录。', data: [], best: null } : {}),
    note: '每行统计对应指定英雄携带该完整三件套的来源样本。排名限定已收录组合；不同组合样本不相加，不代表逐对局联合条件或因果收益。' };
}

export function formatConditionalBuildAnswer(result) {
  if (result.status !== 'ok' || !result.best) return result.reason || '当前条件没有可比较的完整三件套。';
  const row = result.best;
  const value = row.stats[result.query.sort];
  const metric = ({ avgPlacement: '平均名次', top4Rate: '前四率', winRate: '登顶率', sampleSize: '样本数' })[result.query.sort];
  const shown = ['top4Rate', 'winRate'].includes(result.query.sort) ? `${(value * 100).toFixed(1)}%` : String(value);
  const direction = result.query.sortDirection === 'asc' ? '从低到高' : '从高到低';
  return `${row.championName}：${row.items.map(item => item.name).join('＋')}。${result.citation}\n按${metric}${direction}，最低 ${result.query.minSample} 样本；${metric} ${shown}，该组合样本 ${row.stats.sampleSize.toLocaleString('zh-CN')}。`;
}
