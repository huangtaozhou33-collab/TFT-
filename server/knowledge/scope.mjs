/** Only explicitly authored glossary records may bypass game-patch equality. */
export function isGeneralGlossary(record) {
  const payload = record?.document ?? record?.payload;
  return record?.kind === 'glossary' && record.sourcePatch === null && payload?.scope === 'general'
    && /^editorial-v1-[a-f0-9]{16}$/.test(payload?.editorialRevision ?? '');
}
export function knowledgeInScope(record, patch) {
  return record?.eligible !== false && (isGeneralGlossary(record) || !!patch && record?.sourcePatch === patch);
}
export const GENERAL_DOCUMENT_SQL = `(d.kind='glossary' AND d.source_patch IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(d.payload,'$.scope'))='general' AND JSON_UNQUOTE(JSON_EXTRACT(d.payload,'$.editorialRevision')) REGEXP '^editorial-v1-[a-f0-9]{16}$')`;
