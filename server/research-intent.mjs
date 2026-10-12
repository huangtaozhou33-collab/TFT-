import { buildExplorerIndex, matchEntityMentions } from '../public/explorer-search.js';
import { namedBuildItems } from './build-intent.mjs';

const wear = /带上|携带|带着|固定|锁定|带|拿着|装备了/;
const equipmentTail = /^(?:的)?\s*(?:(?:最佳|最好|最优|推荐)\s*)?(?:装备|出装|神装|毕业装|三件套)/;
const wearerTail = /^(?:的)?\s*(?:带上|携带|带着|固定|锁定|带|拿着)/;

export function resolveResearchIntent(question, catalog) {
  if (typeof question !== 'string' || !/装备|出装|神装|毕业装|三件套|胜率|前四|均次|平均名次|统计|队友|阵容|样本/.test(question)) return null;
  const mentions = matchEntityMentions(buildExplorerIndex(catalog), question);
  const heroes = [], heroMentions = [];
  for (const span of mentions) {
    const championCandidates = span.candidates.filter(row => row.type === 'champion');
    if (!championCandidates.length) continue;
    const itemCandidates = span.candidates.filter(row => row.type === 'item');
    const before = question.slice(0, span.start).split(/[，。；!?？;]/).at(-1);
    // 蓝buff/红buff can name jungle units or equipment. A wear clause is an item.
    if (itemCandidates.length && wear.test(before)) continue;
    if (championCandidates.length !== 1 || itemCandidates.length && !/^(?:的|带|携带|同时|上场|和|与|、|，)/.test(question.slice(span.end))) return null;
    const champion = championCandidates[0].entity;
    heroMentions.push({ champion, index: span.start, end: span.end, alias: span.text });
    if (!heroes.some(row => row.id === champion.id)) heroes.push(champion);
  }
  if (heroes.length < 2) return null;
  const named = namedBuildItems(question, catalog);
  if (named.ambiguous || named.some(item => item.excluded) || /分别|相比|对比|比较|还是|不要.*(?:上场|阵容)|排除/.test(question)) return null;
  const equipmentTargets = [...new Set(heroMentions.filter(row => equipmentTail.test(question.slice(row.end))).map(row => row.champion.id))];
  const wearers = [...new Set(heroMentions.filter(row => wearerTail.test(question.slice(row.end))).map(row => row.champion.id))];
  const targets = equipmentTargets.length ? equipmentTargets : wearers;
  const carrierId = targets.length === 1 ? targets[0] : null;
  const items = named.filter(item => !heroMentions.some(hero => hero.index === item.start && hero.end === item.end)).map(({ item, start }) => {
    const holder = heroMentions.filter(hero => hero.end <= start).at(-1);
    const bridge = holder ? question.slice(holder.end, start) : '';
    const holderId = holder && !/[，。；!?？;]/.test(bridge) && wear.test(bridge) ? holder.champion.id : null;
    return { type: 'item', id: item.id, holderId };
  });
  // An unknown/ambiguous explicitly worn item must not disappear from the query.
  if (wearers.length && !items.length) return null;
  const minimum = question.match(/(?:样本至少|最低样本|样本门槛)\s*(\d+)/)?.[1];
  return { conditions: [...heroes.map(champion => ({ type: 'champion', id: champion.id })), ...items],
    ...(carrierId ? { carrierId } : {}), minSample: minimum == null ? 100 : Number(minimum),
    sort: /前四率/.test(question) ? 'top4Rate' : /登顶率|吃鸡率|胜率/.test(question) ? 'winRate' : /样本最多/.test(question) ? 'sampleSize' : 'avgPlacement' };
}
