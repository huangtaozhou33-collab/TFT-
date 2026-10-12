import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cacheContext, cacheKeyFor, sha256, stableJSON } from '../scripts/stats-cache.mjs';
import { cleanText, assetURL } from '../scripts/catalog-normalize.mjs';

export const MECHANICS_DIR = new URL('../data/mechanics/', import.meta.url);
export const MECHANICS_URL = 'https://tactics.tools/info/set-update';
export const MECHANICS_TC_URL = 'https://tactics.tools/tc/info/set-update';
export const RULES_URL = 'https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/enchanted-wilds-overview/';
const CATEGORY_NAMES = { Champion: '英雄', Combat: '战斗', GoldXP: '金币 / 经验', Item: '装备', Misc: '杂项', Risky: '风险交易', Shop: '商店' };
const STAGE_CODES = new Set(['Early', 'EarlyMid', 'Mid', 'MidLate', 'Late', 'VeryLate']);
const VARIANTS = new Set(['base', 'upgraded', 'prismatic']);
async function optionalJSON(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
const normalizedName = name => String(name ?? '').normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
const variantFromID = id => /_Prismatic$/.test(id) ? 'prismatic' : /Upgrade/.test(id) ? 'upgraded' : 'base';
const baseCandidate = id => id.replace(/_Prismatic$/, '').replace(/_?Upgrade(?=18$|$)/, '');

function publicGroups(html, expectedSet) {
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
  if (Number(title?.match(/^Set (\d+) Enchanted Wilds Information$/)?.[1]) !== expectedSet) throw new Error('Public mechanic page set identity does not match the current catalog.');
  const embedded = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!embedded) throw new Error('Public mechanic HTML has no __NEXT_DATA__; no undocumented API fallback.');
  const parsed = JSON.parse(embedded), groups = parsed.props?.pageProps?.anomalies;
  if (parsed.page !== '/info/set-update' || !Array.isArray(groups) || !groups.length || groups.some(group => !Array.isArray(group))) throw new Error('Public mechanic page schema changed.');
  const seen = new Set();
  for (const item of groups.flat()) {
    if (!item || !/^[A-Za-z0-9_]+$/.test(item.id) || seen.has(item.id) || !VARIANTS.has(item.typ) || typeof item.name !== 'string' || typeof item.desc !== 'string') throw new Error('Invalid or duplicate public mechanic entity.');
    if (item.cost != null && (!Number.isSafeInteger(item.cost) || item.cost < 0)) throw new Error('Invalid public mechanic cost.');
    if (item.tier != null && (!Number.isSafeInteger(item.tier) || item.tier < 1 || item.tier > 3)) throw new Error('Invalid public mechanic tier.');
    if (item.category != null && !(item.category in CATEGORY_NAMES)) throw new Error('Unknown public mechanic category.');
    if (!Array.isArray(item.rounds) || item.rounds.some(code => !STAGE_CODES.has(code))) throw new Error('Unknown public mechanic stage label.');
    seen.add(item.id);
  }
  return groups;
}

export function normalizeMechanics({ html, tcHTML = null, riotHTML, zh, en, catalog, fetchedAt, tcFetchedAt = null, rulesFetchedAt, staticManifest }) {
  if (!Number.isFinite(Date.parse(fetchedAt)) || !Number.isFinite(Date.parse(rulesFetchedAt)) || !Number.isFinite(Date.parse(staticManifest?.fetchedAt)) || (tcHTML && !Number.isFinite(Date.parse(tcFetchedAt))) || staticManifest?.assetVersion !== catalog.context.assetVersion) throw new Error('Invalid mechanic capture/version metadata.');
  const set = zh.setData?.find(candidate => candidate.mutator === catalog.context.mutator && candidate.number === catalog.context.set);
  const enSet = en.setData?.find(candidate => candidate.mutator === catalog.context.mutator && candidate.number === catalog.context.set);
  if (!set || !enSet) throw new Error('Static mechanic set mismatch.');
  const groups = publicGroups(html, catalog.context.set); const tcGroups = tcHTML ? publicGroups(tcHTML, catalog.context.set) : [];
  if (!riotHTML?.includes('one Wisp per round') || !riotHTML.includes('every other shop') || !riotHTML.includes('After stage 5') || !riotHTML.includes('during planning phase')) throw new Error('Official Wisp rules could not be verified in the public overview.');
  const currentIDs = new Set(set.items); const english = new Map(en.items.map(item => [item.apiName, item]));
  const current = zh.items.filter(item => currentIDs.has(item.apiName) && /\/wands\/set18_mechanicicon\.(?:tex|dds)$/i.test(item.icon ?? '') && item.isAugment === false && Array.isArray(item.composition) && item.composition.length === 0);
  if (!current.length) throw new Error('No current-set Wisp entities in the static source.');
  const eligible = new Set(current.map(item => item.apiName)); const sourceRows = groups.flat(), publicMap = new Map(sourceRows.map(item => [item.id, item]));
  const tcMap = new Map(tcGroups.flat().map(item => [item.id, item])); const groupByID = new Map(); for (const group of groups) for (const row of group) groupByID.set(row.id, group);
  const context = cacheContext(catalog), cacheKey = cacheKeyFor(catalog);
  const source = { name: 'Tactics.tools + CommunityDragon', url: MECHANICS_URL, set: context.set, gamePatch: null, sourcePatch: null, fetchedAt, sourceTime: null,
    delivery: 'version_cache', cacheKey, assetVersion: context.assetVersion, rulesVersion: context.rulesVersion,
    publicHTMLSha256: sha256(html), tcHTMLSha256: tcHTML ? sha256(tcHTML) : null, tcFetchedAt,
    staticFetchedAt: staticManifest.fetchedAt, staticSourceURL: staticManifest.files?.zh_cn?.url ?? null, staticSha256: staticManifest.files?.zh_cn?.sha256 ?? null,
    sourcePatchReason: '赛季介绍页面未声明这些法杖条目的具体补丁；未借用页面其他导航或统计页补丁。' };
  const rulesSource = { name: 'Riot Games · Enchanted Wilds Overview', url: RULES_URL, set: context.set, sourceTime: '2026-07-27T15:00:00.000Z', fetchedAt: rulesFetchedAt, sourcePatch: null, type: 'official_set_preview', htmlSha256: sha256(riotHTML), note: '发布前瞻用于机制原则；当前数值以本机已绑定资产的实体说明为准。' };
  const staticSource = { name: 'CommunityDragon', url: source.staticSourceURL, set: context.set, assetVersion: context.assetVersion, sourcePatch: null, fetchedAt: staticManifest.fetchedAt, sourceTime: null, sha256: source.staticSha256 };
  const metadataSource = { name: 'Tactics.tools', url: MECHANICS_URL, set: context.set, sourcePatch: null, fetchedAt, sourceTime: null, sha256: source.publicHTMLSha256 };
  const entries = current.map(item => {
    const row = publicMap.get(item.apiName), enItem = english.get(item.apiName), tc = tcMap.get(item.apiName);
    const description = cleanText(item.desc || row?.desc || '', item.effects ?? {}); const variant = row?.typ ?? variantFromID(item.apiName);
    const nameEn = enItem?.name || row?.name || null;
    const group = groupByID.get(item.apiName)?.filter(candidate => eligible.has(candidate.id));
    let links, mappingMethod;
    if (group?.length) { links = Object.fromEntries(group.map(candidate => [candidate.typ, candidate.id])); mappingMethod = 'public_variant_group_and_exact_current_id'; }
    else {
      const stem = baseCandidate(item.apiName);
      const related = current.filter(candidate => baseCandidate(candidate.apiName) === stem && normalizedName(english.get(candidate.apiName)?.name) === normalizedName(nameEn));
      links = Object.fromEntries(related.map(candidate => [variantFromID(candidate.apiName), candidate.apiName])); mappingMethod = 'explicit_id_variant_marker_and_exact_english_name';
    }
    const conditions = /^DA_HandOfBaron18(?:_Upgrade)?$/.test(item.apiName) && html.includes('Hand of Baron requires the Riftbeast trait to be active') ? ['需要已激活峡谷野怪羁绊（来源赛季介绍所述）。'] : null;
    return { id: item.apiName, name: cleanText(item.name).text, nameEn, nameTraditional: tc?.name ?? null, description: description.text || '来源未提供效果说明。', descriptionIncomplete: description.incomplete || !description.text,
      cost: row?.cost ?? null, stages: row?.rounds?.length ? row.rounds : null, category: row?.category ?? null, categoryName: CATEGORY_NAMES[row?.category] ?? null, tier: row?.tier ?? null,
      conditions, upgrade: { variant, baseId: links.base ?? null, upgradedId: links.upgraded ?? null, prismaticId: links.prismatic ?? null, mappingMethod }, icon: assetURL(item.icon, context.assetVersion),
      active: row ? true : null, availability: { status: row ? 'listed_in_current_set_sources' : 'unverified', purchaseConditionsVerified: false, meaning: row ? '当前set成员且公开法杖图鉴列出此ID；不表示任意阶段/局面均可购买。' : '仅静态来源存在；费用、出现阶段和当前可获得性未核验，不确认其可购买。' },
      source: { name: row ? 'CommunityDragon + Tactics.tools' : 'CommunityDragon', url: row ? MECHANICS_URL : source.staticSourceURL, set: context.set, sourcePatch: null, fetchedAt: row ? fetchedAt : staticManifest.fetchedAt,
        identity: 'communitydragon_current_set_exact_id', description: item.desc ? 'communitydragon' : 'tactics.tools', metadata: row ? 'tactics.tools_public_embedded_row_exact_id' : null, variant: row ? 'tactics.tools_public_group' : 'communitydragon_id_marker',
        descriptionSource: item.desc ? staticSource : metadataSource, metadataSource: row ? metadataSource : null,
        conditionsSource: conditions ? metadataSource : null,
        unknownFields: [...(!row ? ['cost', 'stages', 'category', 'tier', 'activeAvailability'] : []), ...(!conditions ? ['offeringConditions'] : []), ...(description.incomplete ? ['dynamicDescriptionValues'] : [])] },
      rating: { status: 'unrated', reason: '该变体暂无经核验的专家评级或统计。' } };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
  const blossom = catalog.traits.find(trait => trait.id === 'DA_18_Blossom');
  const upgradeRules = (blossom?.description ?? '').split(/\n+/).flatMap(line => { const count = Number(line.match(/^\((\d+)\)/)?.[1]); return count && blossom.effects.some(effect => effect.minUnits === count) ? [{ traitId: blossom.id, traitName: blossom.name, minUnits: count, description: line, source: { name: 'CommunityDragon', url: source.staticSourceURL, assetVersion: context.assetVersion, fetchedAt: staticManifest.fetchedAt, set: context.set } }] : []; });
  const rules = ['自然仙灵出现在商店最右格；每隔一个商店出现一次，不是每隔一个回合。', '一般每回合可购买一枚；灵魂莲华羁绊或部分法杖可以改变这一规则。', '只能在准备阶段购买；准备阶段结束或购买后，法杖位置会露出背后的英雄。', '多数效果只持续一回合，具体时效以条目说明为准；不视为永久装备或永久羁绊。', '越往后通常能出现更强的法杖；部分法杖有额外出现条件。', '第5阶段之后，每隔一枚自然仙灵保证属于战斗类别，并非所有自然仙灵都变为战斗类。', '来源分为英雄、战斗、杂项、商店、金币/经验、风险交易和装备七类。'];
  const metadataMapped = entries.filter(entry => publicMap.has(entry.id)).length;
  return { schemaVersion: 1, status: 'cached', delivery: 'version_cache', cacheKey, context, source, evidence: source, rulesSource,
    mechanic: { id: 'wisps', name: '法杖 / 自然仙灵', set: context.set, summary: '商店中的一次性赛季机制，可提供战斗、经济、英雄或装备等效果。', rules, rulesSource, categories: Object.entries(CATEGORY_NAMES).map(([id, name]) => ({ id, name })),
      stageSemantics: 'stages 是公开来源的 Early/EarlyMid/Mid/MidLate/Late/VeryLate 标签；未提供精确数字阶段边界，null 表示未知。', tierSemantics: 'tier 为公开数据库的1–3级字段，不是职业选手S–D攻略评级。', upgradeRules },
    entries, coverage: { entries: entries.length, publicRows: sourceRows.length, metadataMapped, metadataMissing: entries.length - metadataMapped, sourceListed: metadataMapped, availabilityUnverified: entries.length - metadataMapped, note: 'entries为来源目录实体数，不是全部可购买法杖数；仅静态条目的可获得性未核验，listed也不表示任意条件下可购买。', excludedPublicRows: sourceRows.filter(row => !eligible.has(row.id)).map(row => row.id),
      descriptionsComplete: entries.filter(entry => !entry.descriptionIncomplete).length, base: entries.filter(entry => entry.upgrade.variant === 'base').length, upgraded: entries.filter(entry => entry.upgrade.variant === 'upgraded').length, prismatic: entries.filter(entry => entry.upgrade.variant === 'prismatic').length, complete: false },
    rating: { status: 'unrated', reason: '暂无经核验的当前版本全榜或统计；不编造S–D排名。' }, reason: null };
}

export async function readMechanicsSnapshot(catalog, dir = MECHANICS_DIR) {
  const cacheKey = cacheKeyFor(catalog), context = cacheContext(catalog), manifest = await optionalJSON(new URL(`${cacheKey}/manifest.json`, dir));
  if (!manifest || manifest.schemaVersion !== 1 || manifest.cacheKey !== cacheKey || stableJSON(manifest.context) !== stableJSON(context) || !/^[a-f0-9-]{36}\.json$/.test(manifest.file)) return null;
  const payload = await optionalJSON(new URL(`${cacheKey}/${manifest.file}`, dir));
  if (!payload || payload.schemaVersion !== 1 || payload.cacheKey !== cacheKey || stableJSON(payload.context) !== stableJSON(context) || sha256(payload) !== manifest.sha256 || payload.mechanic?.id !== 'wisps' || payload.mechanic.set !== context.set || !Array.isArray(payload.entries)) return null;
  return { payload, manifest };
}
export async function publishMechanicsSnapshot(catalog, payload, raw, dir = MECHANICS_DIR) {
  const cacheKey = cacheKeyFor(catalog), context = cacheContext(catalog);
  if (payload.cacheKey !== cacheKey || stableJSON(payload.context) !== stableJSON(context) || payload.source.publicHTMLSha256 !== sha256(raw.html) || payload.source.tcHTMLSha256 !== (raw.tcHTML ? sha256(raw.tcHTML) : null) || payload.rulesSource.htmlSha256 !== sha256(raw.riotHTML)) throw new Error('Mechanic snapshot context/source validation failed.');
  const captureId = randomUUID(), versionDir = new URL(`${cacheKey}/`, dir); await mkdir(versionDir, { recursive: true });
  const rawDir = new URL(`raw/${cacheKey}/`, dir); await mkdir(rawDir, { recursive: true });
  for (const [name, value] of Object.entries(raw)) if (value != null) await writeFile(new URL(`${captureId}-${name}.html`, rawDir), value);
  const file = `${captureId}.json`; await writeFile(new URL(file, versionDir), JSON.stringify(payload, null, 2));
  if (sha256(await optionalJSON(new URL(file, versionDir))) !== sha256(payload)) throw new Error('Mechanic snapshot disk integrity check failed.');
  const manifest = { schemaVersion: 1, cacheKey, context, file, sha256: sha256(payload), publishedAt: new Date().toISOString(), fetchedAt: payload.source.fetchedAt, sourcePatch: null, coverage: payload.coverage };
  const next = new URL(`manifest.${captureId}.next.json`, versionDir); await writeFile(next, JSON.stringify(manifest, null, 2)); await rename(next, new URL('manifest.json', versionDir)); return manifest;
}

async function withExpertRating(payload, dir) {
  const file = await optionalJSON(new URL(`ratings/set${payload.context.set}-spencer.json`, dir));
  if (!file || file.schemaVersion !== 1 || file.set !== payload.context.set || file.contextKey !== payload.cacheKey || (file.cacheKey != null && file.cacheKey !== payload.cacheKey) || file.source?.type !== 'expert' || file.source?.url !== 'https://www.metatft.com/wisp-tiers' || !Number.isFinite(Date.parse(file.source?.fetchedAt)) || (file.source?.set != null && file.source.set !== payload.context.set) || !['S', 'A', 'B', 'C', 'D'].every(tier => Array.isArray(file.tiers?.[tier]) && file.tiers[tier].every(name => typeof name === 'string' && name.trim()))) return payload;
  const names = new Map(); for (const tier of ['S', 'A', 'B', 'C', 'D']) for (const name of file.tiers[tier]) { const key = normalizedName(name); if (names.has(key)) return payload; names.set(key, { tier, name }); }
  const baseNames = new Map(); for (const entry of payload.entries.filter(entry => entry.upgrade?.variant === 'base')) { const key = normalizedName(entry.nameEn); baseNames.set(key, (baseNames.get(key) ?? 0) + 1); }
  const matched = new Set(); const source = { ...file.source, delivery: 'version_cache', cacheKey: payload.cacheKey, sourcePatch: null, gamePatch: null, recordSha256: sha256(file) };
  const entries = payload.entries.map(entry => {
    const key = normalizedName(entry.nameEn), rating = names.get(key);
    if (entry.upgrade?.variant !== 'base' || !rating || baseNames.get(key) !== 1) return entry;
    matched.add(key); return { ...entry, rating: { status: 'expert', tier: rating.tier, sourceKind: 'expert', source } };
  });
  return { ...payload, entries, rating: { status: 'expert', source, coverage: { sourceEntries: names.size, totalBaseEntries: payload.coverage.base, matchedBaseEntries: matched.size, unmatchedSourceNames: [...names].filter(([key]) => !matched.has(key)).map(([, item]) => item.name), upgradedOrPrismaticInherited: 0 }, reason: '职业选手攻略评级，无胜率统计；仅精确匹配基础变体，升级/棱彩变体不继承。' } };
}
export async function getSeasonMechanic({ catalog, dir = MECHANICS_DIR } = {}) {
  const { readDatabaseSnapshot } = await import('./storage/runtime.mjs');
  const stored = await readDatabaseSnapshot('mechanics');
  if (stored !== undefined) return stored;
  catalog ??= await (await import('./data.mjs')).getCatalog(); const cached = await readMechanicsSnapshot(catalog, dir);
  if (cached) {
    const payload = await withExpertRating(cached.payload, dir);
    let offering;
    try {
      const { getMechanicOfferingConditions } = await import('./mechanics-conditions.mjs');
      offering = await getMechanicOfferingConditions({ catalog, entries: payload.entries, dir });
    } catch {
      offering = { status: 'not_cached', entries: [], rules: [], sources: [], reason: '当前版本法杖出现条件暂不可读取。' };
    }
    const byID = new Map((offering.entries ?? []).map(entry => [entry.id, entry.offeringConditions]));
    const { entries: conditionEntries, ...offeringSummary } = offering;
    return { ...payload, offering: offeringSummary, entries: payload.entries.map(entry => byID.has(entry.id)
      ? { ...entry, offeringConditions: byID.get(entry.id) } : entry) };
  }
  const cacheKey = cacheKeyFor(catalog);
  return { status: 'not_cached', code: 'not_cached', delivery: 'version_cache', cacheKey, context: cacheContext(catalog), source: { name: '赛季机制版本知识库', url: MECHANICS_URL, set: catalog.context.set, sourcePatch: null, gamePatch: null, fetchedAt: null }, mechanic: null, entries: [], rating: { status: 'unrated', reason: '尚无有效当前版本机制图鉴。' }, reason: '当前版本赛季特殊玩法尚未收录或完整性验证失败；网页和 Agent 不会自动联网。请运行独立 sync:mechanics 同步任务。' };
}
