import { buildExplorerIndex } from '../../public/explorer-search.js';
import { libraryChunks, makeChunk, stableJSON, contentHash } from './chunking.mjs';
import { getGlossary, glossaryText } from './glossary.mjs';

const TYPES = { champions: 'champion', items: 'item', traits: 'trait', augments: 'augment', wisps: 'wisp' };
const strings = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];
const patchKnown = value => typeof value === 'string' && /^\d+\.\d+[a-z]?$/.test(value);
const noConflicts = value => Array.isArray(value ?? []) && !(value ?? []).length;
const sourceRecorded = source => Boolean(source && Number.isFinite(Date.parse(source.fetchedAt)) &&
  /^[a-f0-9]{64}$/.test(source.sha256 ?? source.csvSha256 ?? source.htmlSha256 ?? '') &&
  /^https:\/\//.test(source.url ?? source.pageUrl ?? ''));
const compatibleSet = (catalog, pack) => Number.isInteger(catalog.context?.set) && pack.context?.set === catalog.context.set;
const compatiblePatch = (patch, currentPatch) => patchKnown(patch) && (!currentPatch || patch === currentPatch);
const entityRef = (kind, id) => `${TYPES[kind] ?? kind}:${id}`;

function offeringText(entry, condition, patch) {
  return [
    `${entry.name ?? entry.id} · 法杖出现条件`, `适用补丁：${patch ?? '未核验'}`,
    ...(condition.conditionsText ?? []),
    condition.roundWindow ? `出现窗口：${condition.roundWindow.map(window => `${window.from} 至 ${window.to}${window.inclusive ? '（含端点）' : ''}`).join('；')}` : '出现窗口未收录。',
    condition.cooldown ? `再次提供冷却：${condition.cooldown.value} ${condition.cooldown.unit}；从 ${condition.cooldown.trigger} 起算；跨变体共享：${condition.cooldown.sharedAcrossVariants ?? '未知'}。` : '再次提供冷却未知。',
    `全部满足条件：${stableJSON(condition.offerConditions?.allOf ?? condition.allOf ?? [])}`,
    `任一满足条件组：${stableJSON(condition.offerConditions?.anyOf ?? condition.anyOf ?? [])}`,
    `互斥：${stableJSON(condition.excludedBy ?? [])}`,
    `模式：${stableJSON(condition.modes ?? {})}`,
    `购买条件：${stableJSON(condition.purchaseConditions ?? {})}`,
    '这些是已记录的限制，满足它们不保证出现；出现条件与效果触发条件分开。',
    `概率：${condition.probability?.value == null ? '未提供完整权重和候选池分母，无法计算实际概率。' : stableJSON(condition.probability)}`,
    `未知字段：${(condition.unknownFields ?? []).join('、')}`,
    ...(condition.conflicts ?? []).map(conflict => `来源差异：${stableJSON(conflict)}`)
  ].join('\n');
}

/** Build an immutable import view. Callers load/checksum source snapshots beforehand. */
export function buildKnowledgeBundle({ catalog = {}, library = {}, mechanics = {}, glossary = getGlossary() } = {}) {
  const documents = [], chunks = [], entities = [], entityMap = new Map();
  const aliases = new Map(buildExplorerIndex(catalog).entries.map(entry => [entityRef(entry.type, entry.entity.id), entry.ownForms]));
  const addEntity = (kind, entity) => {
    if (!entity?.id || !entity.name) return;
    const id = entityRef(kind, entity.id);
    if (entityMap.has(id)) throw new Error(`Duplicate knowledge entity: ${id}`);
    const row = { id, kind: TYPES[kind] ?? kind, name: entity.name,
      aliases: strings([entity.name, ...(entity.aliases ?? []), entity.nameEn, entity.nameTraditional, ...(aliases.get(id) ?? [])]), payload: entity };
    entities.push(row); entityMap.set(id, row);
  };
  for (const type of ['champions', 'items', 'traits', 'augments']) for (const entity of catalog[type] ?? []) addEntity(type, entity);
  for (const entry of mechanics.entries ?? []) addEntity('wisps', entry);
  const append = (document, text = null) => {
    if (documents.some(existing => existing.id === document.id)) throw new Error(`Duplicate knowledge document: ${document.id}`);
    documents.push(document);
    chunks.push(...(text == null ? libraryChunks(document) : [makeChunk(document, 0, document.title, text, document.payload)]));
  };
  const currentPatch = catalog.context?.gamePatch ?? null;
  for (const doc of library.documents ?? []) {
    const refs = (doc.entities ?? []).map(ref => entityRef(ref.type, ref.id));
    const eligible = compatibleSet(catalog, library) && doc.set === catalog.context.set &&
      compatiblePatch(doc.sourcePatch, currentPatch) && doc.retrievalEligible === true && doc.reviewStatus === 'reviewed' &&
      noConflicts(doc.conflicts) && sourceRecorded(doc.source) && refs.every(id => entityMap.has(id)) &&
      (!doc.source?.pagePatch || doc.source.pagePatch === doc.sourcePatch) &&
      (!doc.source?.sourcePatch || doc.source.sourcePatch === doc.sourcePatch) &&
      (!library.editorial?.referencePatch || doc.sourcePatch === library.editorial.referencePatch);
    append({ id: `library:${doc.id}`, kind: 'library', title: doc.title, entityIds: refs,
      sourcePatch: doc.sourcePatch ?? null, eligible, reviewStatus: eligible ? 'reviewed' : doc.reviewStatus === 'conflict' ? 'conflict' : 'reference',
      source: doc.source ?? null, payload: doc });
  }
  for (const rule of library.augmentRules ?? []) {
    const id = entityRef('augments', rule.id), entity = entityMap.get(id), source = library.rulesSource ?? null;
    if (entity) entity.aliases = strings([...entity.aliases, rule.nameOriginal]);
    const eligible = compatibleSet(catalog, library) && Boolean(entity) && compatiblePatch(rule.sourcePatch, currentPatch) &&
      source?.sourcePatch === rule.sourcePatch && sourceRecorded(source) && noConflicts(rule.conflicts) &&
      Array.isArray(rule.stages) && rule.stages.every(stage => [2, 3, 4].includes(stage)) && Array.isArray(rule.conditionsZh) &&
      Array.isArray(rule.exclusions) && rule.exclusions.every(ref => ref.catalogMapped && entityMap.has(entityRef('augments', ref.id)));
    const document = { id: `augment-rule:${rule.id}`, kind: 'augment_rule', title: `${rule.name ?? entity?.name ?? rule.id} · 海克斯出现条件`,
      entityIds: entity ? [id] : [], sourcePatch: rule.sourcePatch ?? null, eligible, reviewStatus: eligible ? 'reviewed' : 'needs_review', source, payload: rule };
    append(document, [document.title, rule.nameOriginal, `适用补丁：${document.sourcePatch ?? '未核验'}`,
      rule.descriptionZh, `可提供阶段：${(rule.stages ?? []).join('、')}`, `适用模式：${(rule.modes ?? []).join('、')}`,
      ...(rule.conditionsZh ?? []), rule.onePlayerNote,
      `每轮仅一名玩家：${rule.onePlayerPerRound ? '是' : '否'}`,
      `互斥强化：${(rule.exclusions ?? []).map(ref => ref.name ?? ref.id).join('、') || '来源未列出'}`,
      rule.roundVariantsOriginal ? `阶段变体：${rule.roundVariantsOriginal}` : null
    ].filter(Boolean).join('\n'));
  }
  for (const entry of mechanics.entries ?? []) {
    const condition = entry.offeringConditions;
    if (!condition) continue;
    const sources = condition.sources ?? [], knownPatches = [...new Set(sources.map(source => source.sourcePatch).filter(patchKnown))];
    const patch = knownPatches.length === 1 ? knownPatches[0] : null;
    const eligible = compatibleSet(catalog, mechanics) && compatiblePatch(patch, currentPatch) &&
      condition.status === 'documented' && condition.sourceIdentityVerified === true && noConflicts(condition.conflicts) &&
      sources.length > 0 && sources.every(source => source.sourcePatch === patch && sourceRecorded(source)) &&
      !(condition.offerConditions?.unparsed ?? []).length &&
      (condition.excludedBy ?? []).every(ref => ref.catalogMapped && entityMap.has(entityRef('augments', ref.id)));
    const id = entityRef('wisps', entry.id);
    const payload = { id: entry.id, name: entry.name, nameEn: entry.nameEn, offeringConditions: condition };
    append({ id: `wisp-offering:${entry.id}`, kind: 'wisp_offering', title: `${entry.name ?? entry.id} · 法杖出现条件`, entityIds: entityMap.has(id) ? [id] : [],
      sourcePatch: patch, eligible, reviewStatus: eligible ? 'reviewed' : condition.conflicts?.length ? 'conflict' : 'needs_review',
      source: sources.length ? { ...sources[0], evidenceSources: sources } : null, payload }, offeringText(entry, condition, patch));
  }
  if (glossary?.schemaVersion !== 1 || !/^editorial-v1-[a-f0-9]{16}$/.test(glossary.revision ?? '') ||
      glossary.source?.kind !== 'project_editorial' || glossary.source?.sourcePatch !== null || !Array.isArray(glossary.entries) ||
      glossary.revision !== `editorial-v1-${contentHash(glossary.entries).slice(0, 16)}` || glossary.source.revision !== glossary.revision) throw new Error('Invalid glossary editorial metadata');
  for (const entry of glossary.entries) {
    if (!/^[a-z0-9-]+$/.test(entry.id ?? '') || typeof entry.term !== 'string' || !entry.term || typeof entry.definition !== 'string' || !entry.definition || entry.scope !== 'general' || entry.sourcePatch !== null ||
        !['aliases', 'examples', 'misconceptions', 'relatedTerms'].every(key => Array.isArray(entry[key]) && entry[key].every(value => typeof value === 'string'))) throw new Error('Invalid glossary entry');
    if (glossary.edition === 'v4' && (!['source_supported','editorial_common_usage'].includes(entry.evidenceStatus) ||
        !entry.applicability || !entry.disambiguation || entry.verificationStatus !== 'not_independently_verified' ||
        !Array.isArray(entry.references) || entry.evidenceStatus === 'source_supported' && !entry.references.length ||
        entry.references.some(value => { try { const url=new URL(value); return url.protocol!=='https:' || !!url.username || !!url.password; } catch { return true; } }))) throw new Error('Invalid glossary evidence metadata');
    const payload = { ...entry, editorialRevision: glossary.revision };
    append({ id: `glossary:${entry.id}`, kind: 'glossary', title: entry.term, entityIds: [], sourcePatch: null,
      eligible: true, reviewStatus: 'editorial', source: { ...glossary.source, evidenceStatus: entry.evidenceStatus,
        references: entry.references ?? [], verificationStatus: entry.verificationStatus, referenceNote: entry.referenceNote }, payload }, glossaryText(entry));
  }
  return { documents, chunks, entities };
}
