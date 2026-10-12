import { readFileSync } from 'node:fs';
import { contentHash } from './chunking.mjs';
import { matchGlossaryMentions, matchGlossaryEntries } from '../../public/glossary-matching.js';

// Vocabulary explains language. A reference URL and a community label never
// authorize current-season mechanics, entity IDs, item recipes or statistics.
const dataset = JSON.parse(readFileSync(new URL('../../data/glossary/zh-CN.v4.json', import.meta.url), 'utf8'));
const entries = dataset.entries;
const revision = `editorial-v1-${contentHash(entries).slice(0, 16)}`;
const glossary = { schemaVersion: 1, edition: dataset.edition, revision, title: '云顶术语', evidenceLabels: dataset.evidenceLabels,
  source: { name: '本项目术语整理', kind: 'project_editorial', revision, editedAt: dataset.receivedAt, sourcePatch: null,
    note: '用户提供中文社区用法与参考链接；保留原证据标记，链接未逐条独立复核。不是当前补丁规则或强度统计。' }, entries };

export function getGlossary() { return structuredClone(glossary); }
/** Router and API must use the same publication, including before a DB upgrade. */
export async function getPublishedGlossary() {
  const { isDatabaseMode } = await import('../storage/runtime.mjs');
  if (!isDatabaseMode()) return getGlossary();
  const { getSnapshot } = await import('../storage/repository.mjs');
  const snapshot = await getSnapshot('glossary');
  return snapshot ? { ...snapshot.payload, releaseId: snapshot.release.id } : { status: 'unavailable', entries: [], reason: '当前发布尚未包含术语，请先导入新版知识包。' };
}
export { matchGlossaryMentions };
export function matchGlossaryTerms(query, candidates = entries) { return matchGlossaryEntries(query, candidates); }

export function glossaryText(entry) {
  return [entry.term, `别名：${entry.aliases.join('、') || '无'}`, `分类：${entry.category}`, `定义：${entry.definition}`,
    ...entry.examples.map(text => `例句：${text}`), ...entry.misconceptions.map(text => `容易误解：${text}`),
    `相关术语：${entry.relatedTerms.join('、')}`, `适用范围：${entry.applicability || '通用玩家用语；不是补丁规则或强度统计。'}`,
    `证据标记：${entry.evidenceStatus || 'editorial_common_usage'}；有用法或概念来源不等于官方定义。`,
    `参考来源：${entry.references?.join('；') || '常见社区用法整理；未逐条取得直接出处'}`,
    `核验状态：${entry.referenceNote || '本项目编者整理；未逐条独立复核。'}`,
    '本卡仅解释玩家语言。历史机制、英雄是否在场、装备效果和配方必须另查对应赛季，不能用术语卡代替当前统计。'].join('\n');
}
