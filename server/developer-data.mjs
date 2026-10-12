import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { cacheContext, cacheKeyFor, sha256, stableJSON, queryKey, TOOL_NAMES } from '../scripts/stats-cache.mjs';
import { readTraitSnapshot } from './trait-data.mjs';
import { readExplorerSnapshot } from './explorer-overall.mjs';
import { readMechanicsSnapshot } from './mechanics-data.mjs';
import { readOfferingConditionsSnapshot } from './mechanics-conditions.mjs';
import { readLibrarySnapshot } from './library-data.mjs';
import { readTeamCodeMapping } from './team-code.mjs';
import { encodePCCode } from '../public/team-code.js';

const DATA_DIR = new URL('../data/', import.meta.url);
const KEY = /^tft-set\d+-assets\d+\.\d+-[a-f0-9]{12}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ENTITY = /^[A-Za-z0-9_]+$/;
const FAMILIES = [
  { id: 'stats', dir: 'stats', name: 'OP.GG 统计快照', source: 'OP.GG MCP' },
  { id: 'traits', dir: 'traits', name: '羁绊档位统计', source: 'Tactics.tools' },
  { id: 'explorer', dir: 'explorer', name: '弈子与装备整体统计', source: 'Tactics.tools' },
  { id: 'mechanics', dir: 'mechanics', name: '赛季法杖图鉴与规则', source: 'Tactics.tools + CommunityDragon' },
  { id: 'conditions', dir: 'mechanics/conditions', name: '法杖出现条件', source: 'Little Buddy Bot + Riot Games' },
  { id: 'library', dir: 'library', name: '中文机制与海克斯奖励', source: 'Little Buddy Bot · 中文核验' },
  { id: 'teamcodes', dir: 'team-codes', name: 'PC 原生阵容码映射', source: 'CommunityDragon · PC Team Planner' }
];
const OPERATIONS = Object.freeze(Object.fromEntries(['publish', 'rollback', 'rebuild'].map(operation => [operation,
  { enabled: false, permission: 'external_not_configured', mode: 'preview_only', reason: '本页仅查看本地版本资产；未配置执行发布、回滚或重建的外部权限与事务。' }])));
const STORAGE = { engine: 'local_json', status: 'connected', delivery: 'version_cache',
  mysql: { status: 'not_connected' }, milvus: { status: 'not_connected' }, redis: { status: 'not_connected' }, embedding: { status: 'not_configured', vectorIndexed: false },
  note: '实际存储是本机 JSON 文件；文档切片为展示和工具字段投影，不是向量索引。' };
const allowedSourceURLs = new Set(['https://mcp-api.op.gg/mcp', 'https://tactics.tools/traits', 'https://tactics.tools/units', 'https://tactics.tools/items',
  'https://tactics.tools/info/set-update', 'https://tactics.tools/tc/info/set-update', 'https://www.metatft.com/wisp-tiers', 'https://www.littlebuddybot.com/tft-wisps',
  'https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/enchanted-wilds-overview/',
  'https://teamfighttactics.leagueoflegends.com/en-gb/news/game-updates/teamfight-tactics-patch-18-4/',
  'https://teamfighttactics.leagueoflegends.com/en-sg/news/game-updates/teamfight-tactics-patch-13-7-notes-2025/',
  'https://github.com/ttkienn/TFT-Team-Planner-Code/blob/main/TFT.js', 'https://gist.github.com/bangingheads/243e396f78be1a4d49dc0577abf57a0b']);
const fields = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const sensitiveKey = /^(?:api[\s_-]*key|access[\s_-]*token|client[\s_-]*secret|auth(?:orization)?|password|secret|token|credentials?)$/i;
function cleanString(value) {
  let text = String(value).replace(/https?:\/\/[^\s<>"']+/gi, rawURL => {
    try {
      const url = new URL(rawURL); let changed = false;
      if (url.username || url.password) { url.username = '[redacted]'; url.password = ''; changed = true; }
      for (const [key] of url.searchParams) if (sensitiveKey.test(key)) { url.searchParams.set(key, '[redacted]'); changed = true; }
      if (url.hash.includes('=')) {
        const fragment = new URLSearchParams(url.hash.slice(1)); let fragmentChanged = false;
        for (const [key] of fragment) if (sensitiveKey.test(key)) { fragment.set(key, '[redacted]'); fragmentChanged = true; }
        if (fragmentChanged) { url.hash = fragment.toString(); changed = true; }
      }
      return changed ? url.href : rawURL;
    } catch { return rawURL.replace(/^(https?:\/\/)[^/@]+@/i, '$1[redacted]@'); }
  });
  // Quoted JSON values can contain whitespace and escaped quotes. Consume the
  // complete value rather than only its first word (e.g. "Basic <credential>").
  text = text.replace(/((?:"|')?(?:api[\s_-]*key|access[\s_-]*token|client[\s_-]*secret|auth(?:orization)?|password|secret|token|credentials?)(?:"|')?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}]+)/gi, '$1[redacted]');
  return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}
function safeValue(value, depth = 0) {
  if (depth > 20) return null;
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.map(x => safeValue(x, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitiveKey.test(key) && !/(?:api.?key|credential|password|secret|authorization|^prompt$|^environment$)/i.test(key)).map(([key, item]) => [key, safeValue(item, depth + 1)]));
  return value;
}
function publicURL(value) {
  if (typeof value !== 'string') return null;
  if (allowedSourceURLs.has(value)) return value;
  if(/^https:\/\/www\.littlebuddybot\.com\/tft-[a-z-]+$/.test(value)) return value;
  return /^https:\/\/raw\.communitydragon\.org\/\d+\.\d+\/(?:cdragon\/tft\/(?:zh_cn|en_us)\.json|plugins\/rcp-be-lol-game-data\/global\/default\/v1\/tftchampions-teamplanner\.json)$/.test(value) ? value : null;
}
function sourceInfo(value = {}, fallback = '') {
  return safeValue({ name: value.name || value.source || value.id || fallback, url: publicURL(value.url || value.endpoint), sourcePatch: value.sourcePatch ?? value.gamePatch ?? null,
    set: value.set ?? null, assetVersion: value.assetVersion ?? null, fetchedAt: date(value.fetchedAt), sourceTime: date(value.sourceTime),
    type: value.type ?? null, sha256: HASH.test(value.sha256 ?? '') ? value.sha256 : HASH.test(value.recordSha256 ?? '') ? value.recordSha256 : HASH.test(value.rawJSONSha256 ?? '') ? value.rawJSONSha256 : null,
    population: value.population ? fields(value.population, ['queue', 'rank', 'region']) : null,
    sampleDenominator: value.sampleDenominator ?? null, sourceTotalEntries: value.sourceTotalEntries ?? null });
}
function validCatalog(value) {
  try { cacheKeyFor(value); } catch { return false; }
  return ['champions', 'items', 'traits', 'augments'].every(kind => Array.isArray(value[kind]) && value[kind].every(entity => ENTITY.test(entity?.id ?? '') && typeof entity.name === 'string') && new Set(value[kind].map(entity => entity.id)).size === value[kind].length);
}
function statusFor(valid, current, active) { return !valid ? 'invalid' : !current ? 'version_mismatch' : !active ? 'revision_only' : 'ready'; }
function eligibility(pkg, tools = []) {
  const eligible = pkg.validation.valid && pkg.current && pkg.active && tools.length > 0;
  return { eligible, mode: !pkg.validation.valid ? 'blocked' : eligible ? 'current_tool' : 'view_only', tools: eligible ? tools : [],
    reason: !pkg.validation.valid ? '包的版本、结构或哈希校验失败，不得进入检索。' : !pkg.current ? '版本与当前运行目录不匹配，仅供查看。' : !pkg.active ? '不是当前生效清单指向的修订，仅供查看。' : pkg.family === 'teamcodes' ? 'PC 阵容码解析使用的编号映射资料；不进入 AI 游戏统计检索，也不是向量索引。' : !tools.length ? '来源资料可查看，但此内容未映射到当前工具检索实体。' : '当前版本包有效，可由列出的本地工具读取；不表示这条资料在某次回答中已被使用。' };
}
function pagination(items, filters = {}) {
  const positive = (value, fallback, max) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
  const pageSize = positive(filters.pageSize ?? filters.limit, 30, 100), requestedPage = positive(filters.page, 1, 1_000_000), total = items.length, pages = Math.ceil(total / pageSize);
  const page = Math.min(requestedPage, Math.max(1, pages));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total, pages, hasNext: page < pages, hasPrevious: page > 1 } };
}
function filterRows(rows, filters = {}) {
  const query = String(filters.q ?? filters.query ?? '').trim().toLowerCase(), version = filters.cacheKey ?? filters.version;
  return rows.filter(row => (!filters.set || String(row.set) === String(filters.set)) && (!filters.patch || String(row.sourcePatch ?? 'unknown') === String(filters.patch)) &&
    (!filters.source || row.source === filters.source) && (!filters.status || row.status === filters.status) && (!version || row.cacheKey === version) &&
    (!query || `${row.title ?? row.name ?? ''} ${row.entityId ?? ''} ${row.kind ?? ''} ${row.source} ${row.cacheKey} ${row.fingerprint ?? ''} ${row.contentFingerprint ?? ''}`.toLowerCase().includes(query)));
}
function options(rows) {
  const unique = name => [...new Set(rows.map(row => row[name]).filter(value => value != null))].sort((a, b) => String(a).localeCompare(String(b)));
  return { set: unique('set'), patch: [...new Set(rows.map(row => row.sourcePatch ?? 'unknown'))].sort(), source: unique('source'), status: unique('status'), cacheKey: unique('cacheKey'), versions: unique('cacheKey') };
}
function projectionAccounting(documents) {
  const groups = [
    ['tool_mapped', '当前来源记录 · 已映射工具'],
    ['retained_revision', '历史修订 · 保留供追溯'],
    ['other_version', '其他目录版本'],
    ['team_code_reference', '阵容码编号 · 不参与知识问答'],
    ['reference_rule', '参考版本或冲突规则'],
    ['unmapped_rating', '专家评级 · 尚未匹配实体'],
    ['unverified_condition', '法杖条件 · 实体身份未核实'],
    ['other_unavailable', '其他未映射记录']
  ].map(([id, label]) => ({ id, label, count: 0 }));
  const counts = new Map(groups.map(group => [group.id, group]));
  for (const doc of documents) {
    const id = doc.retrievalEligibility.eligible ? 'tool_mapped' : doc.status === 'revision_only' ? 'retained_revision' :
      doc.status === 'version_mismatch' ? 'other_version' : doc.kind.startsWith('team_code_') ? 'team_code_reference' :
      doc.kind === 'library_rule' ? 'reference_rule' : doc.kind === 'mechanic_expert_rating' ? 'unmapped_rating' :
      doc.kind === 'mechanic_offering' ? 'unverified_condition' : 'other_unavailable';
    counts.get(id).count++;
  }
  return { unit: 'source_field_projection', total: documents.length, groups: groups.filter(group => group.count),
    note: '这些是 JSON 来源包按实体和规则生成的展示记录，包含留存修订；不是独立文章，也不是 RAG 文档或向量数量。工具映射只表示目录层有读取入口，运行时仍会检查来源、补丁和统计能力。' };
}

// Only application configuration can replace dataDir (used by isolated fixtures).
// Request filters and opaque document/release IDs never become filesystem paths.
export function createDeveloperData({ dataDir = DATA_DIR } = {}) {
  const rootPath = resolve(dataDir instanceof URL ? fileURLToPath(dataDir) : dataDir), rootURL = pathToFileURL(rootPath + sep);
  async function inside(relativePath) {
    const path = resolve(rootPath, relativePath), suffix = relative(rootPath, path);
    if (suffix.startsWith('..') || isAbsolute(suffix)) return null;
    try {
      // Check every component, including parent junctions inside the whitelist.
      // realpath may be denied by Windows workspace permissions; this fallback
      // still rejects symlink/junction redirects instead of dropping containment.
      if ((await lstat(rootPath)).isSymbolicLink()) return null;
      let component = rootPath;
      for (const segment of suffix.split(sep).filter(Boolean)) {
        component = resolve(component, segment);
        if ((await lstat(component)).isSymbolicLink()) return null;
      }
      try {
        const canonicalRoot = await realpath(rootPath), canonical = await realpath(path), part = relative(canonicalRoot, canonical);
        if (part.startsWith('..') || isAbsolute(part)) return null;
      } catch (error) { if (error.code !== 'EPERM') return null; }
      return path;
    } catch { return null; }
  }
  async function readKnown(relativePath) {
    const path = await inside(relativePath); if (!path) return { ok: false, reason: 'missing_or_disallowed_file' };
    try { const text = await readFile(path, 'utf8'); return { ok: true, value: JSON.parse(text), fileFingerprint: sha256(text) }; }
    catch { return { ok: false, reason: 'invalid_json' }; }
  }
  async function listKnown(relativePath) {
    const path = await inside(relativePath); if (!path) return [];
    try { return (await readdir(path, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink()); } catch { return []; }
  }

  async function scan() {
    const packages = [], documents = [], events = [], catalogRead = await readKnown('catalog.json');
    const catalog = catalogRead.ok && validCatalog(catalogRead.value) ? catalogRead.value : null;
    const current = catalog ? { cacheKey: cacheKeyFor(catalog), context: safeValue(cacheContext(catalog)) } : null;
    function packageEntry({ family, cacheKey, context, fingerprint, revision, active, valid, validationReason, sourcePatch = null, publishedAt = null, fetchedAt = null, publicationState, counts = {}, checksumVerified = true, source, name, sources = [] }) {
      const matches = Boolean(current && cacheKey === current.cacheKey && stableJSON(context) === stableJSON(current.context));
      const id = `pkg_${sha256({ family, cacheKey, revision, fingerprint }).slice(0, 32)}`;
      const pkg = { id, releaseId: `rel_${sha256({ family, cacheKey, revision, fingerprint }).slice(0, 32)}`, family, name, source, sourcePatch, set: context?.set ?? null,
        cacheKey, context: safeValue(context ?? null), assetVersion: context?.assetVersion ?? null, rulesVersion: context?.rulesVersion ?? null, fingerprint, revision,
        status: statusFor(valid, matches, active), current: matches, active, counts, validation: { valid, checksumVerified: valid && checksumVerified, status: !valid ? 'failed' : checksumVerified ? 'verified' : 'schema_valid_checksum_not_recorded', reason: validationReason ?? null },
        publishedAt: date(publishedAt), fetchedAt: date(fetchedAt), publicationState, sources: sources.map(source => sourceInfo(source)), retrievalEligibility: null };
      pkg.retrievalEligibility = eligibility(pkg, []); packages.push(pkg); return pkg;
    }
    function addDocument(pkg, { kind, entityId, title, content, tools, sources = pkg.sources, originalText = null }) {
      const cleanContent = safeValue(content), logicalKey = `${kind}:${entityId}`, fingerprint = sha256({ content: cleanContent, sources, context: pkg.context });
      const doc = { id: `doc_${sha256({ packageId: pkg.id, logicalKey }).slice(0, 32)}`, title: cleanString(title), kind, entityId: cleanString(entityId), logicalKey,
        source: pkg.source, sourcePatch: pkg.sourcePatch, set: pkg.set, cacheKey: pkg.cacheKey, context: pkg.context, packageId: pkg.id,
        fingerprint, contentFingerprint: sha256(cleanContent), status: pkg.status, retrievalEligibility: eligibility(pkg, tools),
        chunking: { strategy: 'structured_tool_fields', vectorIndexed: false, persistedVectorIndex: false,
          note: '按实际工具可用字段生成的展示切片；查询时还会筛选和压缩，不代表独立向量库或已经执行的检索。' },
        sources, content: cleanContent, contentOrigin: 'normalized_entity', originalTextOrigin: 'normalized_source_field',
        contentNote: '内容来自已归一化游戏实体或统计字段；不是任意上游整篇原始文件。', originalText: originalText == null ? null : cleanString(originalText) };
      doc.chunks = Object.entries(cleanContent).filter(([, value]) => value !== undefined).map(([field, content], index) => ({ id: `chunk_${sha256({ documentId: doc.id, field, index }).slice(0, 24)}`, field, content, fingerprint: sha256(content) }));
      doc.chunkCount = doc.chunks.length; documents.push(doc); return doc;
    }
    const staticPkg = packageEntry({ family: 'catalog', source: 'CommunityDragon + OP.GG recipes', name: '当前赛季静态目录', cacheKey: current?.cacheKey ?? null,
      context: current?.context, fingerprint: catalogRead.ok ? sha256(catalogRead.value) : null, revision: 'catalog', active: true, valid: Boolean(catalog),
      validationReason: catalog ? '归一化目录未记录独立发布清单哈希；仅校验当前上下文与实体结构并计算文件指纹，不冒称上游原包完整性已重新验证。' : catalogRead.reason || 'invalid_catalog_context_or_entities',
      checksumVerified: false, fetchedAt: catalog?.context.fetchedAt, publicationState: 'active_file_no_publication_manifest', counts: catalog ? Object.fromEntries(['champions', 'items', 'traits', 'augments'].map(kind => [kind, catalog[kind].length])) : {}, sources: catalog?.sources ?? [] });
    if (catalog) for (const kind of ['champions', 'items', 'traits', 'augments']) for (const entity of catalog[kind]) {
      const content = fields(entity, ['id', 'name', 'cost', 'traits', 'role', 'ability', 'description', 'descriptionIncomplete', 'components', 'kind', 'category', 'traitId', 'traitName', 'unique', 'slotCost', 'recipeVerified', 'allocationVerified', 'effects', 'sourceOnly', 'source']);
      addDocument(staticPkg, { kind: `catalog_${kind}`, entityId: entity.id, title: entity.name, content, tools: ['search_catalog'], originalText: entity.description ?? entity.ability?.description ?? null });
    }
    staticPkg.retrievalEligibility = eligibility(staticPkg, catalog ? ['search_catalog'] : []);

    const normalizedPayloads = new Map();
    for (const family of FAMILIES) for (const directory of (await listKnown(family.dir)).filter(entry => entry.isDirectory() && KEY.test(entry.name))) {
      const key = directory.name, base = `${family.dir}/${key}`, manifestRead = await readKnown(`${base}/manifest.json`), manifest = manifestRead.ok ? manifestRead.value : null;
      if (family.id === 'stats') {
        const candidates = [];
        if (manifest) candidates.push({ manifest, manifestRead, active: true, publicationState: 'active_manifest_pointer', base });
        else packageEntry({ family: family.id, name: family.name, source: family.source, cacheKey: key, context: null, fingerprint: null, revision: 'missing_manifest', active: true, valid: false, validationReason: manifestRead.reason, publicationState: 'invalid_manifest' });
        for (const snapshot of (await listKnown(`${base}/snapshots`)).filter(entry => entry.isDirectory() && UUID.test(entry.name))) {
          if (snapshot.name === manifest?.captureId) continue;
          const read = await readKnown(`${base}/snapshots/${snapshot.name}/manifest.json`);
          if (read.ok) candidates.push({ manifest: read.value, manifestRead: read, active: false, publicationState: 'retained_manifest', base, expectedCaptureId: snapshot.name });
        }
        for (const candidate of candidates) await scanStats(candidate, family, key, catalog, packageEntry, addDocument, events);
        continue;
      }
      const files = (await listKnown(base)).filter(entry => entry.isFile() && UUID.test(entry.name.replace(/\.json$/, '')) && entry.name.endsWith('.json')).map(entry => entry.name);
      const selected = manifest?.file;
      const candidates = [...new Set([...(selected ? [selected] : []), ...files])];
      if (!manifest || !UUID.test(String(selected).replace(/\.json$/, '')) || !String(selected).endsWith('.json')) {
        packageEntry({ family: family.id, name: family.name, source: family.source, cacheKey: key, context: manifest?.context, fingerprint: manifestRead.ok ? sha256(manifest) : null,
          revision: 'invalid_manifest', active: true, valid: false, validationReason: manifestRead.reason || 'invalid_manifest_filename', sourcePatch: manifest?.sourcePatch ?? null, publicationState: 'invalid_manifest' });
      }
      for (const file of candidates) {
        if (!UUID.test(file.replace(/\.json$/, '')) || !file.endsWith('.json')) continue;
        const read = await readKnown(`${base}/${file}`), payload = read.ok ? read.value : null, active = selected === file;
        let valid = Boolean(payload?.schemaVersion === 1 && payload.cacheKey === key && contextMatchesKey(payload.context, key) && familySchema(family.id, payload));
        let validationReason = valid ? null : read.reason || 'invalid_package_context_or_schema';
        if (active && (!manifest || manifest.schemaVersion !== 1 || manifest.cacheKey !== key || stableJSON(manifest.context) !== stableJSON(payload?.context) || !HASH.test(manifest.sha256 ?? '') || (family.id==='library'?read.fileFingerprint:sha256(payload)) !== manifest.sha256)) { valid = false; validationReason = 'manifest_payload_hash_or_context_mismatch'; }
        if (valid && active && catalog && key === current.cacheKey) {
          // Reuse the same validators as application tools, after our whitelist and
          // canonical-path checks. This does not invoke fetch or any raw-source API.
          let verified = null;
          if (family.id === 'traits') verified = await readTraitSnapshot(catalog, new URL('traits/', rootURL));
          if (family.id === 'explorer') verified = await readExplorerSnapshot(catalog, new URL('explorer/', rootURL));
          if (family.id === 'mechanics') verified = await readMechanicsSnapshot(catalog, new URL('mechanics/', rootURL));
          if (family.id === 'library') verified = await readLibrarySnapshot(catalog, new URL('library/', rootURL));
          if (family.id === 'teamcodes') verified = await readTeamCodeMapping(catalog, new URL('team-codes/', rootURL));
          if (family.id === 'conditions') {
            const mechanic = normalizedPayloads.get(`mechanics:${key}`);
            verified = mechanic ? await readOfferingConditionsSnapshot(catalog, mechanic.entries, new URL('mechanics/', rootURL)) : null;
          }
          if (!verified) { valid = false; validationReason = 'current_tool_reader_rejected_package'; }
        }
        if (valid && active) normalizedPayloads.set(`${family.id}:${key}`, payload);
        const sources = payload?.sources ?? payload?.evidence?.sources ?? [payload?.source ?? payload?.evidence ?? {}];
        const pkg = packageEntry({ family: family.id, name: family.name, source: family.source, cacheKey: key, context: payload?.context ?? manifest?.context,
          fingerprint: payload ? sha256(payload) : null, revision: file.slice(0, -5), active, valid, validationReason,
          sourcePatch: payload?.source?.sourcePatch ?? payload?.evidence?.sourcePatch ?? (active ? manifest?.sourcePatch : null) ?? null,
          publishedAt: active ? manifest?.publishedAt : null, fetchedAt: payload?.source?.fetchedAt ?? payload?.evidence?.fetchedAt ?? null,
          publicationState: active ? 'active_manifest_pointer' : 'payload_only', counts: packageCounts(family.id, payload), checksumVerified: active, sources });
        const tools = familyTools(family.id); pkg.retrievalEligibility = eligibility(pkg, tools);
        if (valid) addNormalizedDocuments(pkg, payload, catalog, addDocument);
      }
    }
    await scanRatings(catalog, normalizedPayloads, packageEntry, addDocument);
    const probe = await readKnown('opgg-status.json');
    if (probe.ok) for (const stage of Array.isArray(probe.value.stages) ? probe.value.stages : []) events.push(safeValue({ id: `evt_${sha256({ fetchedAt: probe.value.fetchedAt, name: stage.name, status: stage.status }).slice(0, 24)}`,
      type: 'recorded_probe', source: 'OP.GG MCP', status: stage.status, name: stage.name, occurredAt: date(probe.value.fetchedAt), reason: stage.reason ?? null,
      note: '已有探针记录，不是新调用；不表示历史上每次尝试都已记录。' }));
    for (const pkg of packages.filter(pkg => !pkg.validation.valid)) events.push({ id: `evt_${sha256({ packageId: pkg.id, reason: pkg.validation.reason }).slice(0, 24)}`, type: pkg.validation.status === 'local_files_unavailable' ? 'local_asset_availability' : 'current_validation', source: pkg.source,
      name: pkg.name, status: pkg.validation.status === 'local_files_unavailable' ? 'unavailable' : 'failed', occurredAt: null, observedAt: new Date().toISOString(), reason: pkg.validation.reason, packageId: pkg.id,
      note: '本次只读扫描得到的校验结果，不伪造历史失败时间。' });
    return { current, catalog, packages: dedupePackages(packages), documents, events };

    async function scanStats(candidate, family, key, catalog, packageEntry, addDocument, events) {
      const manifest = candidate.manifest;
      const manifestValid = manifest.schemaVersion === 1 && manifest.cacheKey === key && contextMatchesKey(manifest.context, key) && UUID.test(manifest.captureId ?? '') &&
        (!candidate.expectedCaptureId || candidate.expectedCaptureId === manifest.captureId) && manifest.endpoint === 'https://mcp-api.op.gg/mcp' && manifest.records && typeof manifest.records === 'object' && !Array.isArray(manifest.records);
      const records = [], failures = [];
      if (manifestValid) for (const [recordKey, entry] of Object.entries(manifest.records)) {
        if (!TOOL_NAMES.has(entry?.tool) || !HASH.test(recordKey) || !HASH.test(entry.sha256 ?? '') || entry.file !== `${recordKey}.json` || queryKey(entry.tool, entry.args ?? {}) !== recordKey) { failures.push('invalid_record_index'); continue; }
        const read = await readKnown(`${candidate.base}/snapshots/${manifest.captureId}/records/${entry.file}`), record = read.ok ? read.value : null;
        let valid = Boolean(record && sha256(record) === entry.sha256 && record.cacheKey === key && stableJSON(record.boundContext) === stableJSON(manifest.context) && record.tool === entry.tool && stableJSON(record.args) === stableJSON(entry.args) && statsRecordSchema(record));
        if (valid && candidate.active && catalog && key === current.cacheKey) valid = validStatsEntity(record, catalog);
        if (!valid) failures.push(read.reason || 'record_hash_context_or_schema_mismatch');
        else records.push({ entry, record });
      }
      const valid = Boolean(manifestValid && !failures.length), pkg = packageEntry({ family: family.id, name: family.name, source: family.source, cacheKey: key, context: manifest.context,
        fingerprint: sha256(manifest), revision: manifest.captureId ?? 'invalid_manifest', active: candidate.active, valid,
        validationReason: valid ? null : failures[0] ?? 'invalid_stats_manifest', sourcePatch: null, publishedAt: manifest.publishedAt,
        fetchedAt: null, publicationState: candidate.publicationState, counts: { records: Object.keys(manifest.records ?? {}).length, verifiedRecords: records.length,
          rows: records.reduce((n, row) => n + (row.entry.rowCount ?? 0), 0), unsupported: records.filter(row => row.record.status === 'not_supported').length, validationFailures: failures.length },
        sources: [{ name: 'OP.GG MCP', url: manifest.endpoint }] });
      pkg.retrievalEligibility = eligibility(pkg, valid ? ['get_meta_decks', 'get_champion_build', 'get_item_holders'] : []);
      if (manifestValid && failures.length && failures.every(reason => reason === 'missing_or_disallowed_file')) {
        pkg.status = 'local_files_unavailable';
        pkg.validation.status = 'local_files_unavailable';
        pkg.validation.reason = 'local_snapshot_files_unavailable';
        pkg.counts.localFilesUnavailable = failures.length;
        pkg.counts.validationFailures = 0;
        pkg.retrievalEligibility.mode = 'local_files_unavailable';
        pkg.retrievalEligibility.reason = '本机来源快照未提供或不可读；Docker 镜像不打包原始 OP.GG 快照。这不是数据库损坏结论，数据库发布与索引状态请看存储面板。';
      }
      if (valid) for (const { record, entry } of records) addStatsDocument(pkg, record, entry, catalog, addDocument);
      for (const failure of Array.isArray(manifest.failures) ? manifest.failures : []) events.push(safeValue({ id: `evt_${sha256({ packageId: pkg.id, failure }).slice(0, 24)}`, type: 'recorded_sync_failure', source: family.source, status: 'failed',
        name: failure.tool ?? failure.name ?? '同步记录', occurredAt: date(failure.fetchedAt ?? failure.time), stage: failure.stage ?? null, reason: failure.reason ?? failure.message ?? null, packageId: pkg.id }));
    }

    async function scanRatings(catalog, payloads, packageEntry, addDocument) {
      for (const file of (await listKnown('mechanics/ratings')).filter(entry => entry.isFile() && /^set\d+-spencer\.json$/.test(entry.name))) {
        const read = await readKnown(`mechanics/ratings/${file.name}`), value = read.ok ? read.value : null, key = value?.contextKey ?? value?.cacheKey;
        const mechanic = payloads.get(`mechanics:${key}`), set = Number(file.name.match(/^set(\d+)/)[1]), context = mechanic?.context ?? (current?.context.set === set && current.cacheKey === key ? current.context : { set });
        const tiersValid = ['S', 'A', 'B', 'C', 'D'].every(tier => Array.isArray(value?.tiers?.[tier]) && value.tiers[tier].every(name => typeof name === 'string' && name.trim()));
        const valid = Boolean(value?.schemaVersion === 1 && value.set === set && KEY.test(key ?? '') && (value.cacheKey == null || value.cacheKey === key) && value.source?.type === 'expert' && value.source?.url === 'https://www.metatft.com/wisp-tiers' && date(value.source.fetchedAt) && tiersValid);
        const pkg = packageEntry({ family: 'ratings', name: '法杖专家评级', source: 'MetaTFT · Spencer', cacheKey: key ?? null, context, fingerprint: value ? sha256(value) : null, revision: file.name,
          active: Boolean(mechanic), valid, validationReason: valid ? '独立专家榜未记录发布清单哈希；计算当前文件指纹，不冒称数字签名或不可篡改历史。' : 'invalid_expert_rating_context_or_schema', sourcePatch: null,
          fetchedAt: value?.source?.fetchedAt, publicationState: 'active_file_no_publication_manifest', checksumVerified: false, counts: { sourceEntries: tiersValid ? Object.values(value.tiers).reduce((n, rows) => n + rows.length, 0) : 0 }, sources: [value?.source ?? {}] });
        if (!valid) continue;
        const normalizeName = name => String(name).normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
        const base = new Map(); for (const entry of mechanic?.entries ?? []) if (entry.upgrade?.variant === 'base') { const name = normalizeName(entry.nameEn); base.set(name, [...(base.get(name) ?? []), entry]); }
        let mapped = 0;
        for (const [tier, names] of Object.entries(value.tiers)) for (const name of names) {
          const candidates = base.get(normalizeName(name)) ?? [], entry = candidates.length === 1 ? candidates[0] : null;
          if (entry) mapped++;
          addDocument(pkg, { kind: 'mechanic_expert_rating', entityId: entry?.id ?? `source_name_${sha256(name).slice(0, 20)}`, title: entry?.name ?? name,
            content: { id: entry?.id ?? null, name: entry?.name ?? null, nameEn: name, variant: entry ? 'base' : null, tier, sourceKind: 'expert', statistics: null, mapping: entry ? 'exact_normalized_english_base_name' : 'not_mapped_to_current_base_entry' }, tools: entry ? ['get_season_mechanic'] : [] });
        }
        pkg.counts.mappedBaseEntries = mapped; pkg.retrievalEligibility = eligibility(pkg, mapped && mechanic ? ['get_season_mechanic'] : []);
      }
    }
  }

  const publicPackage = pkg => fields(pkg, ['id', 'releaseId', 'family', 'name', 'source', 'sourcePatch', 'set', 'cacheKey', 'context', 'assetVersion', 'rulesVersion', 'fingerprint', 'status', 'current', 'active', 'counts', 'validation', 'publishedAt', 'fetchedAt', 'publicationState', 'sources', 'retrievalEligibility']);
  const documentMetadata = doc => fields(doc, ['id', 'title', 'kind', 'entityId', 'source', 'sourcePatch', 'set', 'cacheKey', 'context', 'packageId', 'fingerprint', 'contentFingerprint', 'status', 'retrievalEligibility', 'chunking', 'chunkCount', 'contentOrigin', 'originalTextOrigin', 'contentNote']);
  async function getDeveloperOverview(filters = {}) {
    const index = await scan(), filtered = filterRows(index.packages, filters), page = pagination(filtered, filters);
    const mechanic = index.packages.find(pkg => pkg.family === 'mechanics' && pkg.current && pkg.active && pkg.validation.valid);
    return { status: index.current ? 'ready' : 'degraded', current: index.current, storage: STORAGE,
      counts: { entities: { champions: index.catalog?.champions.length ?? 0, items: index.catalog?.items.length ?? 0, traits: index.catalog?.traits.length ?? 0, augments: index.catalog?.augments.length ?? 0, mechanics: mechanic?.counts.entries ?? 0 },
        packages: index.packages.length, documents: index.documents.length, retrievalEligibleDocuments: index.documents.filter(doc => doc.retrievalEligibility.eligible).length,
        validationFailures: index.packages.filter(pkg => !pkg.validation.valid && pkg.validation.status !== 'local_files_unavailable').length,
        localFilesUnavailablePackages: index.packages.filter(pkg => pkg.validation.status === 'local_files_unavailable').length,
        aggregatedRows: index.packages.filter(pkg => pkg.current && pkg.active && pkg.validation.valid).reduce((n, pkg) => n + (pkg.counts.rows ?? 0), 0) },
      sourceAccounting: projectionAccounting(index.documents),
      assets: page.items.map(publicPackage), pagination: page.pagination, filterOptions: options(index.packages), operations: OPERATIONS,
      scope: { whitelistOnly: true, networkRequests: false, engineeringDocumentsIncluded: false, vectorIndex: false } };
  }
  async function getDeveloperDocuments(filters = {}) {
    const index = await scan(), page = pagination(filterRows(index.documents, filters), filters);
    return { status: index.current ? 'ready' : 'degraded', current: index.current, documents: page.items.map(documentMetadata), pagination: page.pagination, filterOptions: options(index.documents),
      note: '此目录展示白名单 JSON 游戏包的实体、规则与统计字段，包含历史修订，不是 MySQL 的 RAG 文档目录；切片是展示字段，不是向量。工具映射不代替运行时来源和补丁检查。工程文档、环境变量和密钥不进入此目录。' };
  }
  async function getDeveloperDocument(id) {
    if (typeof id !== 'string' || !/^doc_[a-f0-9]{32}$/.test(id)) return null;
    const index = await scan(), document = index.documents.find(doc => doc.id === id);
    return document ? safeValue({ ...documentMetadata(document), content: document.content, chunks: document.chunks, originalText: document.originalText, sources: document.sources }) : null;
  }
  async function getDeveloperReleases() {
    const index = await scan(), releases = index.packages.map(pkg => ({ ...publicPackage(pkg), id: pkg.releaseId, packageId: pkg.id }));
    const comparableFamilies = FAMILIES.map(family => family.id).filter(family => releases.filter(row => row.family === family && row.validation.valid && row.validation.checksumVerified).length > 1);
    return { status: 'ready', current: index.current, releases, events: index.events, baseline: { available: comparableFamilies.length > 0, comparableFamilies,
      reason: comparableFamilies.length ? '仅同一资料族、具备独立清单哈希的完整修订可预览比较；payload_only不证明曾发布或已锚定历史哈希。' : '没有第二份具备可验证清单哈希的有效修订，缺少比较和回滚基线。' }, operations: OPERATIONS,
      note: '历史仅来自现存真实清单或留存文件；未记录的更新、失败或生效时间不补造。只预览，不执行回滚。' };
  }
  async function previewDeveloperDiff({ from, to } = {}) {
    if (![from, to].every(id => typeof id === 'string' && /^rel_[a-f0-9]{32}$/.test(id))) return { status: 'invalid_selection', reason: '只接受发布页生成的不透明ID，不能使用文件路径。', previewOnly: true, operations: OPERATIONS };
    const index = await scan(), first = index.packages.find(pkg => pkg.releaseId === from), second = index.packages.find(pkg => pkg.releaseId === to);
    if (!first || !second) return { status: 'invalid_selection', reason: '修订不存在或已改变，请重新加载发布索引。', previewOnly: true, operations: OPERATIONS };
    if (from === to) return { status: 'missing_baseline', reason: '需要两份不同的真实有效修订；相同版本不能构成回滚基线。', previewOnly: true, operations: OPERATIONS };
    if (first.family !== second.family || !first.validation.valid || !second.validation.valid || !first.validation.checksumVerified || !second.validation.checksumVerified) return { status: 'incompatible', reason: '仅允许同一资料族、具备可验证清单哈希的完整有效包进行差异预览；校验失败或只有未锚定文件指纹的修订不能参与。', previewOnly: true, operations: OPERATIONS };
    const before = new Map(index.documents.filter(doc => doc.packageId === first.id).map(doc => [doc.logicalKey, doc])), after = new Map(index.documents.filter(doc => doc.packageId === second.id).map(doc => [doc.logicalKey, doc]));
    const added = [...after.keys()].filter(id => !before.has(id)), removed = [...before.keys()].filter(id => !after.has(id)), changed = [...after.keys()].filter(id => before.has(id) && before.get(id).contentFingerprint !== after.get(id).contentFingerprint), unchanged = [...after.keys()].filter(id => before.has(id) && before.get(id).contentFingerprint === after.get(id).contentFingerprint);
    return { status: 'ready', from: publicPackage(first), to: publicPackage(second), previewOnly: true,
      changes: { added: added.length, removed: removed.length, changed: changed.length, unchanged: unchanged.length, addedIds: added.slice(0, 100), removedIds: removed.slice(0, 100), changedIds: changed.slice(0, 100), listLimit: 100 },
      contextChanged: stableJSON(first.context) !== stableJSON(second.context), rollback: { executable: false, eligibilityAfterRollback: second.current ? 'current_context' : 'would_not_match_current_context', reason: '仅比较资料字段；未执行任何发布指针变更或回滚。' }, operations: OPERATIONS };
  }
  return { getDeveloperOverview, getDeveloperDocuments, getDeveloperDocument, getDeveloperReleases, previewDeveloperDiff };
}

function contextMatchesKey(context, key) { try { return cacheKeyFor({ context }) === key; } catch { return false; } }
function uniqueRows(rows, id = 'id') { return Array.isArray(rows) && rows.every(row => typeof row?.[id] === 'string') && new Set(rows.map(row => row[id])).size === rows.length; }
function familySchema(family, payload) {
  if (payload.sources != null && !Array.isArray(payload.sources)) return false;
  if (family === 'traits') return payload.evidence?.source === 'Tactics.tools' && payload.evidence.url === 'https://tactics.tools/traits' && payload.evidence.set === payload.context?.set && uniqueRows(payload.data) && payload.data.every(row => validNormalizedStats(row.stats));
  if (family === 'explorer') return payload.evidence?.source === 'Tactics.tools' && payload.evidence.set === payload.context?.set && Array.isArray(payload.evidence.sources) && uniqueRows(payload.champions) && uniqueRows(payload.items) && [...payload.champions, ...payload.items].every(row => validNormalizedStats(row.stats));
  if (family === 'mechanics') return payload.mechanic?.id === 'wisps' && payload.mechanic.set === payload.context?.set && uniqueRows(payload.entries) && payload.entries.every(row => ENTITY.test(row.id) && typeof row.name === 'string' && typeof row.description === 'string');
  if (family === 'conditions') return payload.source?.url === 'https://www.littlebuddybot.com/tft-wisps' && payload.source.set === payload.context?.set && uniqueRows(payload.entries) && payload.entries.every(row => ENTITY.test(row.id) && row.offeringConditions) && payload.entityFingerprint === sha256(payload.entries.map(row => row.id).sort());
  if (family === 'library') return uniqueRows(payload.documents)&&uniqueRows(payload.augmentRules)&&payload.documents.every(doc=>typeof doc.title==='string'&&Array.isArray(doc.tables)&&Array.isArray(doc.rules));
  if (family === 'teamcodes') {
    const coverage = payload.coverage, evidence = payload.evidence, expectedURL = `https://raw.communitydragon.org/${payload.context?.assetVersion}/plugins/rcp-be-lol-game-data/global/default/v1/tftchampions-teamplanner.json`;
    if (evidence?.source !== 'CommunityDragon · PC Team Planner' || evidence.url !== expectedURL || evidence.set !== payload.context?.set || evidence.mutator !== payload.context?.mutator || !date(evidence.fetchedAt) || !HASH.test(evidence.rawJSONSha256 ?? '') || !HASH.test(payload.championFingerprint ?? '') || !uniqueRows(payload.entries, 'championId') || !payload.entries.every(row => ENTITY.test(row.championId) && typeof row.name === 'string') || !uniqueRows(coverage?.unmappedCatalog) || !Array.isArray(coverage?.excluded)) return false;
    const ids = [...payload.entries.map(row => row.championId), ...coverage.unmappedCatalog.map(row => row.id)];
    if (new Set(ids).size !== ids.length || ids.some(id => !ENTITY.test(id)) || sha256(ids.sort()) !== payload.championFingerprint || coverage.catalogChampions !== ids.length || coverage.mappedChampions !== payload.entries.length || coverage.sourceRows !== payload.entries.length + coverage.excluded.length || coverage.complete !== (!coverage.excluded.length && !coverage.unmappedCatalog.length)) return false;
    try { encodePCCode([], payload, payload.context); return true; } catch { return false; }
  }
  return false;
}
function packageCounts(family, payload) {
  if(family==='library')return {documents:payload.documents?.length ?? 0,rules:payload.augmentRules?.length ?? 0,reviewed:payload.documents?.filter(doc=>doc.retrievalEligible).length ?? 0};
  if (!payload) return {};
  if (family === 'traits') return { rows: payload.data?.length ?? 0, traits: new Set((payload.data ?? []).map(row => row.traitId)).size };
  if (family === 'explorer') return { rows: (payload.champions?.length ?? 0) + (payload.items?.length ?? 0), champions: payload.champions?.length ?? 0, items: payload.items?.length ?? 0 };
  if (family === 'teamcodes') return { entries: payload.entries?.length ?? 0, sourceRows: payload.coverage?.sourceRows ?? 0, mappedChampions: payload.coverage?.mappedChampions ?? 0,
    catalogChampions: payload.coverage?.catalogChampions ?? 0, unmappedChampions: payload.coverage?.unmappedCatalog?.length ?? 0, excluded: payload.coverage?.excluded?.length ?? 0, complete: payload.coverage?.complete ?? false };
  return { entries: payload.entries?.length ?? 0, rules: (payload.mechanic?.rules ?? payload.rules ?? []).length };
}
function familyTools(family) { return ({ traits: ['get_trait_stats'], explorer: ['get_explorer_stats'], mechanics: ['get_season_mechanic'], conditions: ['get_season_mechanic'],library:['get_library_knowledge'] })[family] ?? []; }
function addNormalizedDocuments(pkg, payload, catalog, addDocument) {
  if(pkg.family==='library') {
    for(const row of payload.documents) {
      const doc=addDocument(pkg,{kind:'library_rule',entityId:row.id,title:row.title,content:fields(row,['id','category','summary','rules','tables','entities','sourcePatch','reviewStatus','retrievalEligible','conflicts']),tools:row.retrievalEligible?['get_library_knowledge']:[],sources:[sourceInfo({...row.source,sourcePatch:row.sourcePatch,sourceTime:row.source.imageUpdatedAt})]});
      doc.sourcePatch=row.sourcePatch;
      if(!row.retrievalEligible)doc.retrievalEligibility.reason='参考版本或来源冲突；当前数值问答不引用该表。';
    }
    for(const row of payload.augmentRules)addDocument(pkg,{kind:'augment_offering',entityId:row.id,title:`${row.name} · 出现条件`,content:row,tools:['get_library_knowledge'],sources:[sourceInfo({...payload.rulesSource,url:payload.rulesSource.pageUrl})]});
  }
  if (pkg.family === 'teamcodes') {
    const addMappingDocument = projection => {
      const document = addDocument(pkg, { ...projection, tools: [] });
      document.chunking.note = 'PC 阵容码编号与格式说明的结构化展示切片；不进入 AI 统计工具或向量检索。';
      document.contentNote = '内容来自版本映射包的规范化字段，供 PC 阵容码解析核验；不是统计结果或上游原始文件全文。';
    };
    addMappingDocument({ kind: 'team_code_rules', entityId: 'pc_native_format', title: 'PC 原生阵容码 · 格式与覆盖范围', content: {
      format: 'riot_pc', platform: 'pc', supportedVersions: [1, 2], capacity: 10, includes: { champions: true, items: false, positions: false, stars: false },
      coverage: payload.coverage, championFingerprint: payload.championFingerprint,
      mapping: fields(payload.evidence, ['idJoin', 'v1Mapping', 'v2Mapping', 'compatibility', 'populationCostAvailable', 'note']),
      references: { mapping: publicURL(payload.evidence.url), officialSupport: publicURL(payload.evidence.officialSupport), formatResearch: (Array.isArray(payload.evidence.formatResearch) ? payload.evidence.formatResearch : []).map(publicURL).filter(Boolean) } } });
    for (const row of payload.entries) addMappingDocument({ kind: 'team_code_mapping', entityId: row.championId, title: `${row.name} · PC 阵容码编号`,
      content: { ...fields(row, ['championId', 'name', 'cost', 'v1', 'v2']), mappingStatus: 'mapped', idJoin: 'exact_character_id_to_current_catalog', formats: { '01': 'v1', '02': 'v2' } } });
    for (const row of payload.coverage.unmappedCatalog) addMappingDocument({ kind: 'team_code_unmapped', entityId: row.id, title: `${row.name ?? row.id} · PC 映射未收录`,
      content: { ...fields(row, ['id', 'name', 'reason']), mappingStatus: 'not_mapped', v1: null, v2: null, encodingSupported: false } });
  }
  if (pkg.family === 'traits') for (const row of payload.data) addDocument(pkg, { kind: 'trait_stats', entityId: row.id, title: `${row.name} · ${row.minUnits ?? row.level}人档`, content: fields(row, ['id', 'traitId', 'name', 'tier', 'level', 'minUnits', 'maxUnits', 'stats', 'mapping']), tools: ['get_trait_stats'] });
  if (pkg.family === 'explorer') for (const [kind, rows] of [['champion_overall', payload.champions], ['item_overall', payload.items]]) for (const row of rows) addDocument(pkg, { kind, entityId: row.id, title: row.name, content: fields(row, ['id', 'name', 'cost', 'traits', 'kind', 'category', 'stats', 'topItems', 'sourceId']), tools: ['get_explorer_stats'], sources: payload.evidence.sources?.filter(source => source.id === row.sourceId).map(source => sourceInfo(source)) ?? pkg.sources });
  if (pkg.family === 'mechanics') {
    for (const row of payload.entries) addDocument(pkg, { kind: 'mechanic_entry', entityId: row.id, title: row.name, content: fields(row, ['id', 'name', 'nameEn', 'description', 'descriptionIncomplete', 'cost', 'stages', 'category', 'categoryName', 'conditions', 'upgrade', 'active', 'availability']), tools: ['get_season_mechanic'],
      sources: [row.source?.descriptionSource, row.source?.metadataSource, row.source?.conditionsSource].filter(Boolean).map(source => sourceInfo(source)), originalText: row.description });
    for (const [index, rule] of (payload.mechanic?.rules ?? []).entries()) addDocument(pkg, { kind: 'mechanic_rule', entityId: `rule_${index}`, title: `法杖规则 ${index + 1}`, content: { text: rule }, tools: ['get_season_mechanic'], sources: [sourceInfo(payload.rulesSource, 'Riot Games')], originalText: typeof rule === 'string' ? rule : null });
  }
  if (pkg.family === 'conditions') {
    for (const row of payload.entries) addDocument(pkg, { kind: 'mechanic_offering', entityId: row.id, title: catalog?.items.find(item => item.id === row.id)?.name ?? row.id,
      content: { id: row.id, offeringConditions: fields(row.offeringConditions, ['status', 'conditionsText', 'sourceText', 'allOf', 'anyOf', 'excludedBy', 'roundWindow', 'sourceRoundWindow', 'cooldown', 'offerConditions', 'purchaseConditions', 'triggerConditions', 'weight', 'probability', 'modes', 'sourceIdentityVerified', 'unknownFields', 'conflicts']) },
      tools: row.offeringConditions.sourceIdentityVerified ? ['get_season_mechanic'] : [], sources: (row.offeringConditions.sources ?? []).map(source => sourceInfo(source)), originalText: row.offeringConditions.sourceText });
    for (const rule of payload.rules ?? []) addDocument(pkg, { kind: 'mechanic_offering_rule', entityId: rule.id, title: rule.text, content: fields(rule, ['id', 'type', 'text', 'constraint', 'sourceNames', 'sourceRefs']), tools: ['get_season_mechanic'], originalText: rule.text });
  }
}
function validStatsEntity(record, catalog) {
  const champions = new Set(catalog.champions.map(row => row.id)), items = new Set(catalog.items.map(row => row.id));
  if (record.status === 'not_supported') return record.tool === 'tft_list_champions_for_item' && items.has(record.args?.item_id);
  if (record.tool === 'tft_get_champion_item_build') return champions.has(record.args?.champion_id) && Array.isArray(record.body?.data) && record.body.data.every(row => row.characterId === record.args.champion_id && Array.isArray(row.itemNames));
  if (record.tool === 'tft_list_champions_for_item') return items.has(record.args?.item_id) && Array.isArray(record.body);
  if (record.tool === 'tft_list_meta_decks') return Array.isArray(record.body?.data);
  if (record.tool === 'tft_list_item_combinations') return record.body?.set === catalog.context.set && Array.isArray(record.body?.data);
  if (record.tool === 'tft_list_augments') return Array.isArray(record.body?.headers) && Array.isArray(record.body?.rows);
  return false;
}
function validNormalizedStats(stats) { return Boolean(stats && Number.isSafeInteger(stats.sampleSize) && stats.sampleSize >= 0 && Number.isFinite(stats.avgPlacement) && stats.avgPlacement >= 1 && stats.avgPlacement <= 8 && Number.isFinite(stats.top4Rate) && stats.top4Rate >= 0 && stats.top4Rate <= 1 && Number.isFinite(stats.winRate) && stats.winRate >= 0 && stats.winRate <= 1); }
function statsRecordSchema(record) {
  if (record.endpoint !== 'https://mcp-api.op.gg/mcp' || !date(record.fetchedAt) || !record.args || typeof record.args !== 'object') return false;
  if (record.status === 'not_supported') return ['tft_get_champion_item_build', 'tft_list_champions_for_item'].includes(record.tool);
  if (record.status !== 'ok') return false;
  if (record.tool === 'tft_get_champion_item_build') return ENTITY.test(record.args.champion_id ?? '') && Array.isArray(record.body?.data) && record.body.data.every(row => row && typeof row === 'object' && row.characterId === record.args.champion_id && Array.isArray(row.itemNames) && row.itemNames.every(id => typeof id === 'string'));
  if (record.tool === 'tft_list_champions_for_item') return ENTITY.test(record.args.item_id ?? '') && Array.isArray(record.body) && record.body.every(row => row && typeof row === 'object' && typeof row.characterId === 'string');
  if (record.tool === 'tft_list_meta_decks') return Array.isArray(record.body?.data) && record.body.data.every(deck => deck && typeof deck === 'object' && Array.isArray(deck.units) && Array.isArray(deck.traits));
  if (record.tool === 'tft_list_item_combinations') return Array.isArray(record.body?.data);
  if (record.tool === 'tft_list_augments') return Array.isArray(record.body?.headers) && Array.isArray(record.body?.rows);
  return false;
}
const normalizedStat = (row, sample) => Object.fromEntries([['avgPlacement', row.avgPlacement], ['top4Rate', row.top4Rate], ['winRate', row.winRate], ['pickRate', row.pickRate], ['sampleSize', row[sample]]].map(([key, value]) => [key, typeof value === 'number' && Number.isFinite(value) ? value : null]));
function addStatsDocument(pkg, record, entry, catalog, addDocument) {
  const source = sourceInfo({ name: 'OP.GG MCP', url: record.endpoint, fetchedAt: record.fetchedAt, sourceTime: record.body?.metadata?.gameStatDateTime, sourcePatch: record.body?.version ?? null, set: record.boundContext?.set,
    sampleDenominator: record.tool === 'tft_get_champion_item_build' ? 'itemCount (champion occurrences with this build)' : record.tool === 'tft_list_champions_for_item' ? 'totalCount (champion occurrences holding this item)' : 'stat.deck.compsCount' });
  const championMap = new Map((catalog?.champions ?? []).map(row => [row.id, row])), itemMap = new Map((catalog?.items ?? []).map(row => [row.id, row]));
  if (record.tool === 'tft_get_champion_item_build') {
    const id = record.args.champion_id, rows = (record.body?.data ?? []).filter(row => row.characterId === id && Array.isArray(row.itemNames) && (!pkg.current || row.itemNames.every(item => itemMap.has(item))));
    addDocument(pkg, { kind: 'champion_builds', entityId: id, title: `${championMap.get(id)?.name ?? id} · 装备搭配统计`, content: { championId: id, rows: rows.map(row => ({ itemIds: row.itemNames, stats: normalizedStat(row, 'itemCount'), populationDenominator: row.totalChampionCount ?? null })) }, tools: ['get_champion_build'], sources: [source] });
  } else if (record.tool === 'tft_list_champions_for_item') {
    const id = record.args.item_id, unsupported = record.status === 'not_supported', rows = unsupported ? [] : (record.body ?? []).filter(row => !pkg.current || championMap.has(row.characterId));
    addDocument(pkg, { kind: 'item_holders', entityId: id, title: `${itemMap.get(id)?.name ?? id} · 持有者统计`, content: { itemId: id, status: unsupported ? 'not_supported' : 'cached', rows: rows.map(row => ({ championId: row.characterId, stats: normalizedStat(row, 'totalCount') })), ...(unsupported ? { reason: '公开来源工具schema不支持此实体，无统计行。' } : {}) }, tools: unsupported ? [] : ['get_item_holders'], sources: [source] });
  } else if (record.tool === 'tft_list_meta_decks') for (const deck of (record.body?.data ?? []).filter(deck => !pkg.current || (String(deck.teamCode ?? '').endsWith(catalog.context.mutator) && deck.units?.every(unit => championMap.has(unit.key))))) {
    addDocument(pkg, { kind: 'meta_deck', entityId: String(deck.id), title: deck.name?.zh_CN || deck.name?.en_US || String(deck.id), content: { id: deck.id,
      units: (deck.units ?? []).map(unit => ({ id: unit.key, items: unit.items ?? [], isCore: unit.isCore, star: unit.tier, cell: unit.cell })),
      traits: (deck.traits ?? []).map(trait => ({ id: trait.key, count: trait.numUnits })), stats: normalizedStat(deck.stat?.deck ?? {}, 'compsCount') }, tools: ['get_meta_decks'], sources: [source] });
  }
  // Source recipe/augment tables are not exposed as raw documents. Current tool
  // projections already come from the normalized catalog and its exact entities.
}
function dedupePackages(packages) { return [...new Map(packages.map(pkg => [pkg.id, pkg])).values()]; }

const api = createDeveloperData();
export const getDeveloperOverview = api.getDeveloperOverview;
export const getDeveloperDocuments = api.getDeveloperDocuments;
export const getDeveloperDocument = api.getDeveloperDocument;
export const getDeveloperReleases = api.getDeveloperReleases;
export const previewDeveloperDiff = api.previewDeveloperDiff;
