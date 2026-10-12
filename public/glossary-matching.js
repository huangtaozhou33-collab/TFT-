// Shared, deterministic vocabulary matching for routing and the published RAG
// corpus. Keep the original query intact; candidates are meanings, not rewrites.
export const normalizeGlossaryText = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ambiguousAttributes = new Set(['攻速', '护甲', '魔抗', '拳头']);
const componentContext = /散件|组件|合成|选秀|掉了|掉落|拿个|拿一|拿到|缺一个|缺一件|拿(?:攻速|护甲|魔抗|拳头)/;
const variableForms = { 'earn-interest': /吃[0-9一二两三四五六七八九十]+息/gu, roll: /d[0-9一二两三四五六七八九十几]+(?:下|次)/gu,
  'stage-round': /(?<![0-9])\d{1,2}-\d{1,2}(?![0-9])/gu };
const cueRules = {
  'fast-eight': /升[到上]?八|上八|八级|升级|人口|fast\s*8|攻略|运营/,
  'fast-eighth': /出局|老八|淘汰|第八|又速[八8]了/,
  'deny-units': /占牌|卡对手|卡别人|卡他|牌池|限制|同行/,
  'twisted-fate': /崔斯特|卡牌大师|哪张牌|英雄|技能|出装/,
  'spend-start': /金币|回合|阶段|搜牌|开d|升级|\d+-\d+/,
  'combat-start': /技能|施法|法力|蓝条|叠层|变身|这张卡|启动太慢/,
};

export function matchGlossaryMentions(query, entries = []) {
  const clean = normalizeGlossaryText(query);
  if (!clean || clean.length > 6000 || !Array.isArray(entries)) return [];
  const hits = [];
  for (const entry of entries) {
    const forms = new Set([entry.term, ...(entry.aliases ?? [])].filter(Boolean).map(normalizeGlossaryText));
    if (variableForms[entry.id]) for (const match of clean.matchAll(variableForms[entry.id])) forms.add(match[0]);
    for (const form of forms) {
      if (!form || ambiguousAttributes.has(form) && !componentContext.test(clean)) continue;
      const pattern = new RegExp(escape(form), 'gu');
      for (const match of clean.matchAll(pattern)) {
        const start = match.index, end = start + form.length;
        // ASCII boundaries also protect mixed forms (D牌, 主C, 3星, 2-1).
        if (/^[a-z0-9_]/.test(form) && /[a-z0-9_]/.test(clean[start - 1] || '') ||
            /[a-z0-9_]$/.test(form) && /[a-z0-9_]/.test(clean[end] || '')) continue;
        hits.push({ start, end, form, entry });
      }
    }
  }
  const longest = [];
  for (const hit of hits.sort((a,b)=>(b.end-b.start)-(a.end-a.start)||a.start-b.start)) {
    if (!longest.some(other=>hit.start<other.end && hit.end>other.start && (hit.start!==other.start || hit.end!==other.end))) longest.push(hit);
  }
  const spans = new Map();
  for (const hit of longest) {
    const key = `${hit.start}:${hit.end}`;
    if (!spans.has(key)) spans.set(key, { start: hit.start, end: hit.end, text: clean.slice(hit.start, hit.end), candidates: [] });
    const span = spans.get(key);
    if (!span.candidates.some(entry => entry.id === hit.entry.id)) span.candidates.push(hit.entry);
  }
  // The supplied Q&A also covers indirect wording such as “我差一滴水”.
  // An exact authored question may add its card, but never hide other mentions.
  for (const entry of entries) if (entry.exampleQuestion && normalizeGlossaryText(entry.exampleQuestion) === clean &&
      ![...spans.values()].some(span=>span.candidates.some(candidate=>candidate.id===entry.id))) {
    spans.set(`example:${entry.id}`,{start:0,end:clean.length,text:clean,matchedBy:'example',candidates:[entry]});
  }
  return [...spans.values()].sort((a, b) => a.start - b.start).map(span => ({ ...span,
    // Context prioritizes readings; it does not erase a homonym or claim certainty.
    candidates: span.candidates.sort((a, b) => Number(cueRules[b.id]?.test(clean) || false) - Number(cueRules[a.id]?.test(clean) || false) || a.id.localeCompare(b.id)),
    ambiguous: span.candidates.length > 1 }));
}

export function matchGlossaryEntries(query, entries = []) {
  const byId = new Map();
  for (const span of matchGlossaryMentions(query, entries)) for (const entry of span.candidates) if (!byId.has(entry.id)) byId.set(entry.id, structuredClone(entry));
  return [...byId.values()];
}
