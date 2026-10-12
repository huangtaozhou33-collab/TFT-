import { createHash } from 'node:crypto';

export const stableJSON = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const contentHash = value => createHash('sha256').update(typeof value === 'string' ? value : stableJSON(value)).digest('hex');

const lines = values => values.filter(value => value !== null && value !== undefined && String(value).length).join('\n');

export function makeChunk(document, ordinal, title, text, payload) {
  const hash = contentHash({ title, text, payload });
  return {
    id: `chunk:${contentHash({ documentId: document.id, ordinal, sourcePatch: document.sourcePatch, contentHash: hash })}`,
    documentId: document.id, ordinal, title, text, entityIds: [...document.entityIds],
    sourcePatch: document.sourcePatch, eligible: document.eligible, contentHash: hash, payload,
    ...(document.kind === 'glossary' ? { kind: 'glossary' } : {})
  };
}

/** A conditional reward group is atomic, even when it exceeds the soft target. */
export function tableGroups(table, softCharacters = 1800) {
  const rows = table.rows ?? [];
  if (!rows.length) return [{ condition: table.condition ?? null, rows: [], rowIndices: [] }];
  const conditional = rows.some(row => row.condition !== undefined && row.condition !== null);
  if (conditional) {
    const groups = new Map();
    rows.forEach((row, index) => {
      const condition = row.condition ?? table.condition ?? null;
      const key = stableJSON(condition);
      if (!groups.has(key)) groups.set(key, { condition, rows: [], rowIndices: [] });
      groups.get(key).rows.push(row); groups.get(key).rowIndices.push(index);
    });
    return [...groups.values()];
  }
  // Without explicit branch conditions, a probability table is one reward pool.
  if (table.condition != null || rows.some(row => row.probability != null)) {
    return [{ condition: table.condition ?? null, rows: [...rows], rowIndices: rows.map((_, i) => i) }];
  }
  const groups = []; let group = { condition: null, rows: [], rowIndices: [] }, size = 0;
  rows.forEach((row, index) => {
    const rowSize = stableJSON(row).length;
    if (group.rows.length && size + rowSize > softCharacters) { groups.push(group); group = { condition: null, rows: [], rowIndices: [] }; size = 0; }
    group.rows.push(row); group.rowIndices.push(index); size += rowSize;
  });
  if (group.rows.length) groups.push(group);
  return groups;
}

export function libraryChunks(document) {
  const doc = document.payload;
  const context = lines([doc.title, doc.summary, document.sourcePatch ? `适用补丁：${document.sourcePatch}` : '适用补丁：未核验', ...(doc.rules ?? [])]);
  const chunks = [makeChunk(document, 0, doc.title, context, { kind: 'overview', summary: doc.summary ?? '', rules: doc.rules ?? [], aliases: doc.aliases ?? [] })];
  (doc.tables ?? []).forEach((table, tableIndex) => {
    for (const group of tableGroups(table)) {
      const title = lines([doc.title, table.title, group.condition]).replaceAll('\n', ' · ');
      const text = lines([
        context, `表格：${table.title ?? ''}`, group.condition == null ? null : `条件：${typeof group.condition === 'string' ? group.condition : stableJSON(group.condition)}`,
        table.probabilityBasis ? `概率分母：${table.probabilityBasis}` : null,
        table.exhaustive === true ? '以下保留该条件的全部奖励分支。' : null,
        (table.columns ?? []).join(' | '), ...group.rows.map(row => (row.cells ?? []).join(' | ')),
        table.note ? `表下注释：${table.note}` : null,
        doc.probabilitiesRounded ? '概率为来源舍入值，合计可能存在舍入误差。' : null
      ]);
      chunks.push(makeChunk(document, chunks.length, title, text, {
        kind: 'table', tableIndex, rowIndices: group.rowIndices, condition: group.condition,
        table: { ...table, rows: group.rows }, rules: doc.rules ?? [], probabilitiesRounded: doc.probabilitiesRounded ?? false
      }));
    }
  });
  return chunks;
}
