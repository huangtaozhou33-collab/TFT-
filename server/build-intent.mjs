import { buildExplorerIndex, matchEntityMentions } from '../public/explorer-search.js';
import { buildQueryFromExplorer, normalizeBuildQuery } from '../public/build-query.js';

export function namedBuildItems(question, catalog) {
  const mentions = matchEntityMentions(buildExplorerIndex(catalog), question, 'item');
  const candidates = mentions.filter(span => !span.ambiguous && span.candidates[0].entity.kind !== 'component')
    .map(span => ({ item: span.candidates[0].entity, start: span.start, end: span.end }));
  const matched = [];
  for (const candidate of candidates) {
    if (matched.some(other => candidate.start < other.end && candidate.end > other.start || candidate.item.id === other.item.id)) continue;
    const clause = question.slice(0, candidate.start).split(/[，。；!?？;]/).at(-1);
    const negative = [...clause.matchAll(/不带|不含|排除|不要|不用|不考虑|禁用/g)].at(-1)?.index ?? -1;
    const positive = [...clause.matchAll(/固定|必须带|已带|带上/g)].at(-1)?.index ?? -1;
    const excluded = negative >= 0 && negative >= positive;
    matched.push({ ...candidate, excluded });
  }
  // Consumers must not turn an ambiguous fixed item into an unconstrained query.
  Object.defineProperty(matched, 'ambiguous', { value: mentions.some(span => span.ambiguous) });
  return matched;
}

export function resolveBuildIntent(question, catalog, { championId, explorer = null } = {}) {
  const context = buildQueryFromExplorer(explorer || {});
  const target = championId || context?.championId;
  if (!target) return null;
  const contextApplies = context?.championId === target;
  const named = namedBuildItems(question, catalog);
  if (named.ambiguous) return null;
  const wantsEquipment = /装备|出装|神装|毕业装|三件套|三件|补齐|剩下.*件|其余.*件/.test(question);
  const contextRequested = contextApplies && explorer?.mode === 'builds' && /当前|这些条件|这个条件|这套|怎么搭|最佳|推荐|最好/.test(question);
  const fixedRequested = wantsEquipment && named.length && /带|固定|锁定|必须|已有|有了|拿到|最佳|最好|最强|最优|推荐/.test(question);
  if (!contextRequested && !(wantsEquipment && contextApplies && context.requiredItemIds.length) && !fixedRequested) return null;
  const reset = /只固定|仅固定|改成|改为|换成/.test(question) && named.length;
  const required = reset || !contextApplies ? [] : [...context.requiredItemIds];
  const excluded = reset || !contextApplies ? [] : [...context.excludedItemIds];
  for (const match of named) {
    const targetList = match.excluded ? excluded : required, other = match.excluded ? required : excluded;
    const previous = other.indexOf(match.item.id); if (previous >= 0) other.splice(previous, 1);
    if (!targetList.includes(match.item.id)) targetList.push(match.item.id);
  }
  const minimum = question.match(/(?:最低样本|样本(?:数)?(?:至少|不少于|门槛为?|≥|>=)?)\s*(\d+)/)?.[1];
  const explicitSort = /前四率/.test(question) ? 'top4Rate' : /登顶率|吃鸡率|胜率/.test(question) ? 'winRate' : /平均名次|均次/.test(question) ? 'avgPlacement' : /按样本|样本最多/.test(question) ? 'sampleSize' : null;
  const sort = explicitSort || (contextApplies ? context.sort : 'avgPlacement');
  return normalizeBuildQuery({ championId: target, requiredItemIds: required, excludedItemIds: excluded,
    minSample: minimum == null ? contextApplies ? context.minSample : 100 : Number(minimum), sort,
    sortDirection: explicitSort || !contextApplies ? sort === 'avgPlacement' ? 'asc' : 'desc' : context.sortDirection });
}
