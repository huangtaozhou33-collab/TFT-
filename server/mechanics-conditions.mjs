import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cacheContext, cacheKeyFor, sha256, stableJSON } from '../scripts/stats-cache.mjs';

export const CONDITIONS_DIR = new URL('../data/mechanics/', import.meta.url);
export const LITTLE_BUDDY_URL = 'https://www.littlebuddybot.com/tft-wisps';
export const RIOT_CONDITIONS_URL = 'https://teamfighttactics.leagueoflegends.com/en-gb/news/game-updates/teamfight-tactics-patch-18-4/';
const PATCH = '18.4';
const BANDS = [
  ['Early', '2-1', '2-7'], ['Early Mid', '3-1', '3-4'], ['Mid', '3-5', '4-1'],
  ['Mid Late', '4-2', '4-7'], ['Late', '5-1', '5-7'], ['Very Late', '6-1', '10-1']
];
const normalizeName = input => String(input ?? '').normalize('NFKC').replace(/[‘’]/g, "'").trim().toLowerCase();
const htmlDecode = input => String(input).replace(/&quot;/g, '"').replace(/&#(?:39|x27);/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const validDate = input => typeof input === 'string' && Number.isFinite(Date.parse(input));
async function optionalJSON(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
const entityFingerprint = entries => sha256(entries.map(entry => entry.id).sort());

export function inspectLittleBuddyHTML(html) {
  if (!html.includes('TFT Set 18') || !html.includes(`TFT Wisp offer rules (${PATCH})`)) throw new Error('Little Buddy source set/patch is not verified as Set 18 patch 18.4.');
  const widgets = [];
  for (const match of html.matchAll(/<astro-island\b([^>]*)>/g)) {
    const props = match[1].match(/\bprops="([^"]*)"/)?.[1]; if (!props) continue;
    const parsed = JSON.parse(htmlDecode(props));
    const walk = value => { if (typeof value === 'string' && value.includes('SHEET_CSV_URL') && value.includes('COL_CONDITIONS')) widgets.push(value); else if (value && typeof value === 'object') for (const child of Object.values(value)) walk(child); }; walk(parsed);
  }
  if (widgets.length !== 1) throw new Error('Public Little Buddy widget schema changed.');
  const widget = htmlDecode(widgets[0]), csvURL = widget.match(/var SHEET_CSV_URL\s*=\s*"([^"]+)"/)?.[1];
  if (!csvURL?.startsWith('https://docs.google.com/spreadsheets/d/e/') || !csvURL.endsWith('output=csv')) throw new Error('No page-declared published CSV; no guessed API fallback.');
  if (!widget.includes('After this Wisp is offered, it cannot be seen again for this many Wisp shops.')) throw new Error('Re-offer cooldown units are unverified.');
  for (const [key, from, to] of BANDS) if (!widget.includes(`key: "${key}"`) || !widget.includes(`label: "${from} to ${to}"`)) throw new Error('Public round band bounds changed.');
  return { csvURL, patch: PATCH, set: 18, widgetSha256: sha256(widget) };
}

export function parsePublishedCSV(csv) {
  const table = []; let row = [], value = '', quoted = false;
  csv = String(csv).replace(/^\uFEFF/, '');
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') { if (quoted && csv[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && csv[i + 1] === '\n') i++; row.push(value); value = ''; if (row.some(Boolean)) table.push(row); row = []; }
    else value += char;
  }
  if (quoted) throw new Error('Unterminated CSV quoted field.');
  if (value || row.length) { row.push(value); table.push(row); }
  const headers = table.shift();
  const required = ['Name', 'mName', 'Cost', 'Standard', 'Doubles', 'Special Conditions', 'Re-offer Cooldown', ...BANDS.map(([key]) => key), 'MutuallyExclusiveItem1'];
  if (!headers || new Set(headers).size !== headers.length || required.some(key => !headers.includes(key))) throw new Error('Public CSV headers changed.');
  const rows = table.map(values => { if (values.length !== headers.length) throw new Error('CSV row width mismatch.'); return Object.fromEntries(headers.map((header, i) => [header, values[i]])); });
  const seen = new Set();
  for (const item of rows) {
    if (!/^[A-Za-z0-9_]+$/.test(item.mName) || seen.has(item.mName)) throw new Error('Invalid or duplicate actual Wisp ID.'); seen.add(item.mName);
    for (const key of ['Cost', 'Re-offer Cooldown']) if (!/^\d+$/.test(item[key])) throw new Error(`Unverified numeric ${key}.`);
    for (const [key] of BANDS) if (item[key] && item[key] !== key) throw new Error('Unverified round-band cell.');
    for (const key of ['Standard', 'Doubles']) if (item[key] && !['Yes', 'No'].includes(item[key])) throw new Error('Unknown game-mode marker.');
  }
  return rows;
}

function traitDictionary(catalog, englishTraits) {
  const result = new Map();
  for (const trait of englishTraits ?? []) { const match = catalog.traits.find(row => row.id === trait.apiName); if (match) result.set(normalizeName(trait.name), { id: match.id, name: match.name, nameEn: trait.name, mappingMethod: 'current_static_trait_id_and_exact_english_name' }); }
  return result;
}
const ROLES = { Tank: '坦克', Caster: '施法者', Fighter: '战士', Marksman: '射手', Assassin: '刺客', Specialist: '专家' };
function parseSpecialConditions(input, traits, catalog) {
  const clauses = String(input ?? '').replace(/^Requires:\s*/i, '').replace(/\.$/, '').split(/;\s*/).filter(Boolean);
  const allOf = [], anyOf = [], unparsed = [], texts = [];
  const add = (field, op, value, scope, text, extra = {}) => { const rule = { field, op, value, scope, text, sourceRefs: ['littlebuddy18.4'], ...extra }; allOf.push(rule); texts.push(text); return rule; };
  const traitRule = (name, active) => { const match = traits.get(normalizeName(name)); if (!match) return null; return { field: 'traitActive', op: 'eq', value: active, scope: 'board', trait: match, text: `${match.name}羁绊${active ? '已激活' : '未激活'}`, sourceRefs: ['littlebuddy18.4'] }; };
  const heldItemConstraint = names => {
    const requested = names.flatMap(name => [name, `Radiant ${name}`]);
    const found = requested.map(name => catalog.items?.find(item => item.aliases?.some(alias => normalizeName(alias) === normalizeName(name))));
    if (found.some(item => !item)) return null;
    return { field: 'heldItemCount', op: 'eq', value: 0, scope: 'held_items_source_scope', itemIds: found.map(item => item.id), text: `未持有${found.map(item => item.name).join('、')}（含光明版）`, sourceRefs: ['littlebuddy18.4'], mappingMethod: 'exact_current_item_english_alias' };
  };
  for (const clause of clauses) {
    let match;
    if ((match = /^At least (\d+) gold$/i.exec(clause))) add('gold', 'gte', Number(match[1]), 'player', `持有金币至少 ${match[1]}`);
    else if ((match = /^Less than (\d+) gold$/i.exec(clause))) add('gold', 'lt', Number(match[1]), 'player', `持有金币少于 ${match[1]}`);
    else if ((match = /^More than (\d+) player health remaining$/i.exec(clause))) add('playerHealth', 'gt', Number(match[1]), 'player', `玩家生命值大于 ${match[1]}`);
    else if ((match = /^level (\d+) or higher$/i.exec(clause))) add('playerLevel', 'gte', Number(match[1]), 'player', `玩家等级至少 ${match[1]}`);
    else if (/^On a win streak \(any length\)$/i.test(clause)) add('winStreak', 'gte', 1, 'player', '处于任意长度的连胜');
    else if ((match = /^not on a (win|loss) streak of (\d+) or more$/i.exec(clause))) add(match[1].toLowerCase() === 'win' ? 'winStreak' : 'lossStreak', 'lt', Number(match[2]), 'player', `不处于 ${match[2]} 连${match[1].toLowerCase() === 'win' ? '胜' : '败'}或更长的连${match[1].toLowerCase() === 'win' ? '胜' : '败'}`);
    else if ((match = /^(?:offered )?only offered? in the first (\d+) seconds of the planning phase$/i.exec(clause)) || (match = /^Offered only in the first (\d+) seconds of the planning phase$/i.exec(clause))) add('planningElapsedSeconds', 'lte', Number(match[1]), 'round', `仅准备阶段开始后的前 ${match[1]} 秒出现`, { lowerInclusive: 0, upperBoundaryExact: false });
    else if ((match = /^(\w+) (not active|active)$/i.exec(clause))) { const rule = traitRule(match[1], match[2].toLowerCase() === 'active'); if (rule) { allOf.push(rule); texts.push(rule.text); } else { unparsed.push(clause); texts.push(clause); } }
    else if ((match = /^(.+) all inactive$/i.exec(clause))) { const names = match[1].split(/,\s*|\s+and\s+/), rules = names.map(name => traitRule(name, false)); if (rules.every(Boolean)) { allOf.push(...rules); texts.push(rules.map(rule => rule.text).join('；')); } else { unparsed.push(clause); texts.push(clause); } }
    else if ((match = /^At least (\d+) (Tanks|Casters|Fighters|Marksmans) on the board$/i.exec(clause))) { const role = match[2].slice(0, -1); add('roleChampionCount', 'gte', Number(match[1]), 'board', `棋盘上至少 ${match[1]} 名${ROLES[role]}`, { role, roleClassificationSource: 'littlebuddy_source_game_role' }); }
    else if ((match = /^an itemized (Tank|Caster|Fighter|Marksman) on your board$/i.exec(clause))) add('itemizedRoleChampionCount', 'gte', 1, 'board', `棋盘上至少 1 名已装备物品的${ROLES[match[1]]}`, { role: match[1] });
    else if (/^At least 3 Fighters or Assassins on the board$/i.test(clause)) add('roleChampionCount', 'gte', 3, 'board', '棋盘上至少3名战士或刺客', { roleIn: ['Fighter', 'Assassin'] });
    else if (/^an itemized Assassin or Fighter on your board$/i.test(clause)) add('itemizedRoleChampionCount', 'gte', 1, 'board', '棋盘上至少1名已装备物品的刺客或战士', { roleIn: ['Assassin', 'Fighter'] });
    else if (/^An itemized Attack Assassin, Caster, Marksman, Fighter or Specialist on your board$/i.test(clause)) add('itemizedRoleChampionCount', 'gte', 1, 'board', '棋盘上至少1名已装备物品、伤害类别为Attack且角色为刺客/施法者/射手/战士/专家的英雄', { damageCategory: 'Attack', roleIn: ['Assassin', 'Caster', 'Marksman', 'Fighter', 'Specialist'] });
    else if (/^An itemized Magic Caster, Fighter, Marksman or Assassin\s*on your board$/i.test(clause)) add('itemizedRoleChampionCount', 'gte', 1, 'board', '棋盘上至少1名已装备物品、伤害类别为Magic且角色为施法者/战士/射手/刺客的英雄', { damageCategory: 'Magic', roleIn: ['Caster', 'Fighter', 'Marksman', 'Assassin'] });
    else if (/^Not offered when a manaless champion on the board holds 3 items$/i.test(clause)) add('championCount', 'eq', 0, 'board', '棋盘上不存在携带3件物品的无蓝条英雄', { filter: { manaless: true, itemCount: 3 } });
    else if (/^Not offered while you hold Last Whisper, Void Staff, Ionic Spark or Evenshroud \(base or Radiant\)$/i.test(clause)) { const rule = heldItemConstraint(['Last Whisper', 'Void Staff', 'Ionic Spark', 'Evenshroud']); if (rule) { allOf.push(rule); texts.push(rule.text); } else { unparsed.push(clause); texts.push(clause); } }
    else if (/^Either no Morellonomicon, Sunfire Cape or Red Buff \(base or Radiant\), or Inferno active$/i.test(clause)) { const items = heldItemConstraint(['Morellonomicon', 'Sunfire Cape', 'Red Buff']), inferno = traitRule('Inferno', true); if (items && inferno) { anyOf.push({ alternatives: [items, inferno], sourceRefs: ['littlebuddy18.4'] }); texts.push(`${items.text}，或${inferno.text}`); } else { unparsed.push(clause); texts.push(clause); } }
    else if ((match = /^At least (\d+) champions anywhere in your army that can critically strike with abilities$/i.exec(clause))) add('abilityCritChampionCount', 'gte', Number(match[1]), 'army_any_location', `队伍中（位置不限）至少 ${match[1]} 名可技能暴击的英雄`);
    else if ((match = /^At least (\d+) (\d+)-star champions on your board$/i.exec(clause))) add('championCount', 'gte', Number(match[1]), 'board', `棋盘上至少 ${match[1]} 名 ${match[2]} 星英雄`, { filter: { stars: Number(match[2]) } });
    else if ((match = /^At least (\d+) champions on your board with no items$/i.exec(clause))) add('championCount', 'gte', Number(match[1]), 'board', `棋盘上至少 ${match[1]} 名未装备物品的英雄`, { filter: { itemCount: 0 } });
    else if ((match = /^At least (\d+) champions on your board each holding (\d+) or more items$/i.exec(clause))) add('championCount', 'gte', Number(match[1]), 'board', `棋盘上至少 ${match[1]} 名英雄各自携带至少 ${match[2]} 件物品`, { filter: { itemCountGte: Number(match[2]) } });
    else if ((match = /^At least (\d+) inactive traits \(contributed but not active\)$/i.exec(clause))) add('inactiveContributedTraitCount', 'gte', Number(match[1]), 'board', `至少贡献 ${match[1]} 个尚未激活的羁绊`);
    else if ((match = /^At least (\d+) active non-unique traits$/i.exec(clause))) add('activeNonUniqueTraitCount', 'gte', Number(match[1]), 'board', `至少 ${match[1]} 个已激活的非独有羁绊`);
    else if ((match = /^At least (\d+) champion on your bench$/i.exec(clause))) add('championCount', 'gte', Number(match[1]), 'bench', `备战席至少 ${match[1]} 名英雄`);
    else if ((match = /^A (\d+)-cost champion in your army$/i.exec(clause))) add('championCount', 'gte', 1, 'army', `队伍中至少 1 名 ${match[1]} 费英雄`, { filter: { cost: Number(match[1]) } });
    else if (/^A 1-cost or 2-cost champion at 2 stars or higher on your board or bench$/i.test(clause)) add('championCount', 'gte', 1, 'board_or_bench', '棋盘或备战席至少 1 名两星及以上的 1 费或 2 费英雄', { filter: { costIn: [1, 2], starsGte: 2 } });
    else if ((match = /^At least (\d+) stacking items in your army$/i.exec(clause))) add('stackingItemCount', 'gte', Number(match[1]), 'army', `队伍中至少 ${match[1]} 件叠层物品`, { itemClassificationComplete: false });
    else if ((match = /^At least (\d+) item components? on your bench$/i.exec(clause))) add('componentCount', 'gte', Number(match[1]), 'bench', `备战席至少 ${match[1]} 件基础装备`);
    else if ((match = /^At least (\d+) item components, including completed items \(counts as (\d+) components\)$/i.exec(clause))) add('componentEquivalentCount', 'gte', Number(match[1]), 'source_inventory_scope_unspecified', `至少 ${match[1]} 个装备散件等价量；每件成装按 ${match[2]} 个散件计算`, { completedItemEquivalent: Number(match[2]) });
    else if (/^No 3-star champion$/i.test(clause)) add('championCount', 'eq', 0, 'army', '队伍中没有 3 星英雄', { filter: { stars: 3 } });
    else if (/^a running subtotal of your army's unit sell values reaches between 15 and 24 gold$/i.test(clause)) add('runningArmySellSubtotalHitsRange', 'eq', true, 'army', '逐个累加队伍内单位售价时，运行中的小计曾达到 15–24 金币；不是总棋盘价值必须小于 25', { range: { min: 15, max: 24 }, traversalOrder: null });
    else if ((match = /^You have not already taken the (Bear|Tiger|Turtle) Primal blessing$/i.exec(clause))) add('primalBlessingTaken', 'eq', false, 'player', `尚未获得${({ Bear: '熊', Tiger: '虎', Turtle: '龟' })[match[1]]}的原始祝福`, { blessingSourceName: match[1] });
    else if (/^Exactly 2 or 3 \(no more or less\) champions holding 3 items each$/i.test(clause)) add('championCount', 'in', [2, 3], 'source_army_scope_unspecified', '恰好 2 或 3 名英雄各携带 3 件物品', { filter: { itemCount: 3 } });
    else if (/^At least 2 1-star champions on your board, OR a 1-star 5-cost champion on your board holding 3 items$/i.test(clause)) { const options = [{ field: 'championCount', op: 'gte', value: 2, scope: 'board', filter: { stars: 1 } }, { field: 'championCount', op: 'gte', value: 1, scope: 'board', filter: { stars: 1, cost: 5, itemCount: 3 } }]; anyOf.push({ alternatives: options, sourceRefs: ['littlebuddy18.4'] }); texts.push('棋盘上至少 2 名一星英雄，或至少 1 名携带 3 件物品的一星 5 费英雄'); }
    else { unparsed.push(clause); texts.push(clause); }
  }
  return { allOf, anyOf, unparsed, texts };
}

export function normalizeMechanicOfferingConditions({ catalog, entries, littleBuddyHTML, csv, riotHTML, fetchedAt, pageFetchedAt, riotFetchedAt, englishTraits = [], traitSource = null }) {
  if (catalog.context.set !== 18 || !Array.isArray(entries) || !entries.length || new Set(entries.map(entry => entry.id)).size !== entries.length || [fetchedAt, pageFetchedAt, riotFetchedAt].some(value => !validDate(value))) throw new Error('Invalid offering set/entity/capture metadata.');
  const page = inspectLittleBuddyHTML(littleBuddyHTML), rows = parsePublishedCSV(csv);
  if (!/<title[^>]*>TFT patch 18\.4<\/title>/i.test(riotHTML) || !riotHTML.includes('we can only show you Wisps that you can afford') || !riotHTML.includes('under 10 gold') || !riotHTML.includes('Stage 4-1 to 5-7') || !riotHTML.includes('first 2 seconds of Planning Phase') || !riotHTML.includes('below 20 HP')) throw new Error('Riot 18.4 offering changes not verified in the public patch HTML.');
  const context = cacheContext(catalog), cacheKey = cacheKeyFor(catalog), dictionary = traitDictionary(catalog, englishTraits), actual = new Map(rows.map(row => [row.mName, row]));
  const sources = [
    { id: 'littlebuddy18.4', name: 'Little Buddy Bot · Wisp offer rules', url: LITTLE_BUDDY_URL, dataUrl: page.csvURL, set: 18, sourcePatch: PATCH, type: 'datamined_reference', fetchedAt, pageFetchedAt, sourceTime: null, csvSha256: sha256(csv), htmlSha256: sha256(littleBuddyHTML), widgetSha256: page.widgetSha256 },
    { id: 'riot18.4', name: 'Riot Games · TFT patch 18.4', url: RIOT_CONDITIONS_URL, set: 18, sourcePatch: PATCH, type: 'official_patch', fetchedAt: riotFetchedAt, sourceTime: riotHTML.includes('2026-10-06T18:00:00.000Z') ? '2026-10-06T18:00:00.000Z' : null, htmlSha256: sha256(riotHTML) }
  ];
  const rules = [
    { id: 'affordability', type: 'offer', text: '当前只会提供玩家买得起的法杖；金额比较使用18.4条件表的费用，不能借用补丁未知的旧费用。', constraint: { field: 'gold', op: 'gte', valueFrom: 'purchaseConditions.cost.value' }, sourceRefs: ['riot18.4'] },
    { id: 'new_low_gold_wisps', type: 'offer', text: '18.4新增的法力细雨、树丛铠甲、回归的好友，以及源名Room for a Shroom，仅在持有金币少于10且4-1至5-7时出现，费用均为0；不把此窗口套给所有0费法杖。', sourceNames: ['Drizzle', 'Grove Armor', 'Returning Friend', 'Room for a Shroom'], sourceRefs: ['riot18.4'] },
    { id: 'polymorph_timing', type: 'offer', text: '变形术类法杖仅在准备阶段最初2秒提供。', sourceRefs: ['riot18.4'] },
    { id: 'low_hp_exclusion', type: 'offer', text: 'Riot规定生命值低于20时不提供属性消耗品、金鹅、重大冒险和易货；Little Buddy相关行写生命值大于20。恰好20的资格存在来源边界差异，未作保证。', sourceRefs: ['riot18.4', 'littlebuddy18.4'] },
    { id: 'reoffer_cooldown', type: 'reoffer', text: '冷却在该法杖被提供后计算，单位为法杖商店次数；不是购买后冷却，也不是普通回合数。', sourceRefs: ['littlebuddy18.4'] },
    { id: 'probability_unknown', type: 'uncertainty', text: '本来源提供出现限制与窗口，未给完整法杖池权重或概率分母；无法据此保证必出，不能套英雄商店等级概率。', sourceRefs: ['littlebuddy18.4', 'riot18.4'] }
  ];
  const newNames = new Set(['drizzle', 'grove armor', 'returning friend', 'room for a shroom']);
  const normalizeRow = (entry, row) => {
    if (!row) return { id: entry.id, offeringConditions: { status: 'not_documented', conditionsText: ['当前18.4条件表未列出此实际变体ID；不继承其他变体门槛。'], sourceText: null, allOf: [], anyOf: [], excludedBy: [], roundWindow: null, cooldown: null,
      offerConditions: { status: 'not_documented', allOf: [], anyOf: [], unparsed: [], complete: false }, purchaseConditions: { cost: null, allOf: [], sourceRefs: [] }, triggerConditions: { status: 'not_extracted', reference: 'entry.description' },
      weight: { value: null, unit: 'relative_weight', scope: 'current_offering_pool', sourceRefs: [] }, probability: { value: null, unit: 'fraction', denominator: null, scope: 'current_offering_pool' }, unknownFields: ['offeringConditions', 'currentPurchaseCost', 'cooldown', 'roundWindow', 'weight', 'probability'], conflicts: [], sources: [] } };
    const parsed = parseSpecialConditions(row['Special Conditions'], dictionary, catalog), sourceRoundWindow = BANDS.filter(([key]) => row[key]).map(([label, from, to]) => ({ from, to, inclusive: true, label, sourceRefs: ['littlebuddy18.4'] }));
    let roundWindow = sourceRoundWindow.length ? sourceRoundWindow : null;
    const cost = Number(row.Cost), constraints = [...parsed.allOf], conflicts = [], excludedBy = [];
    const conditionsText = [...parsed.texts];
    for (let i = 1; i <= 25; i++) {
      const id = row[`MutuallyExclusiveItem${i}`]?.trim(); if (!id) continue;
      const match = catalog.augments.find(augment => augment.id === id);
      excludedBy.push({ id, name: match?.name ?? row[`MutuallyExclusiveItem${i}Name`] ?? id, nameEn: row[`MutuallyExclusiveItem${i}Name`] || null, type: 'augment', catalogMapped: Boolean(match), sourceRefs: ['littlebuddy18.4'] });
    }
    if (excludedBy.length) conditionsText.push(`持有这些强化时不出现：${excludedBy.map(item => item.name).join('、')}`);
    if (newNames.has(normalizeName(row.Name))) {
      roundWindow = [{ from: '4-1', to: '5-7', inclusive: true, sourceRefs: ['riot18.4'] }];
      if (!constraints.some(rule => rule.field === 'gold' && rule.op === 'lt' && rule.value === 10)) constraints.push({ field: 'gold', op: 'lt', value: 10, scope: 'player', text: '持有金币少于10', sourceRefs: ['riot18.4'] });
      if (cost !== 0) conflicts.push({ field: 'purchaseCost', type: 'source_conflict', littleBuddyValue: cost, riotValue: 0 });
      conflicts.push({ field: 'roundWindow', type: 'official_patch_override', littleBuddyValue: sourceRoundWindow, riotValue: roundWindow, reason: '官方明确4-1开始，CSV阶段分组从4-2开始；显示官方窗口，保留原分组。' });
      conditionsText.push('Riot18.4明确出现窗口4-1至5-7；源表阶段分组从4-2开始，保留差异。');
    }
    if (/polymorph$/i.test(row.Name)) {
      if (!constraints.some(rule => rule.field === 'planningElapsedSeconds' && rule.value === 2)) constraints.push({ field: 'planningElapsedSeconds', op: 'lte', value: 2, lowerInclusive: 0, upperBoundaryExact: false, scope: 'round', text: '仅准备阶段最初2秒出现', sourceRefs: ['riot18.4'] });
    }
    const hpLimited = /^(?:Knick-Knack|Thingamajig|Doodad) (?:Jar|Bag|Sack)$/i.test(row.Name) || ['golden goose', 'major gambit', 'barter'].includes(normalizeName(row.Name));
    if (hpLimited) { conflicts.push({ field: 'playerHealth', type: 'boundary_conflict', littleBuddyConstraint: 'playerHealth > 20', riotExclusion: 'playerHealth < 20', unresolvedValue: 20, reason: 'Riot仅明确低于20排除，LBB行要求大于20；恰好20是否可出现未作一致确认。', sourceRefs: ['littlebuddy18.4', 'riot18.4'] }); conditionsText.push('生命值恰好20时存在来源边界差异，不能保证可出现。'); }
    const cooldown = { value: Number(row['Re-offer Cooldown']), unit: 'wisp_shops', trigger: 'offered', scope: 'source_wisp_row', sharedAcrossVariants: null, sourceRefs: ['littlebuddy18.4'] };
    const affordability = { field: 'gold', op: 'gte', value: cost, scope: 'player', text: `当前18.4费用${cost}金币，只有买得起时才能被提供`, sourceRefs: ['littlebuddy18.4', 'riot18.4'] };
    constraints.push(affordability); conditionsText.push(affordability.text);
    const rowSource = { ...sources[0], actualId: row.mName, mappingMethod: 'exact_actual_id_no_variant_inheritance' };
    return { id: entry.id, offeringConditions: { status: parsed.unparsed.length || conflicts.some(conflict => conflict.type !== 'official_patch_override') ? 'partial' : 'documented', conditionsText, sourceText: row['Special Conditions'] || null, allOf: constraints, anyOf: parsed.anyOf, excludedBy,
      roundWindow, sourceRoundWindow, cooldown, offerConditions: { status: 'documented_constraints_only', allOf: constraints, anyOf: parsed.anyOf, unparsed: parsed.unparsed, complete: false, eligibilityGuaranteed: false },
      purchaseConditions: { cost: { value: cost, unit: 'gold', scope: 'actual_id', sourceRefs: ['littlebuddy18.4'] }, allOf: [affordability], sourceRefs: ['littlebuddy18.4', 'riot18.4'] },
      triggerConditions: { status: 'not_extracted', reference: 'entry.description', source: entry.source?.descriptionSource ?? null, reason: '效果触发与时效保留在效果说明，未当成商店出现限制。' },
      weight: { value: null, unit: 'relative_weight', scope: 'current_offering_pool', sourceRefs: [], reason: '公开表未提供权重。' }, probability: { value: null, unit: 'fraction', denominator: null, scope: 'current_offering_pool', reason: '没有权重与完整候选池分母，不能推算实际概率。' },
      modes: { standard: row.Standard ? row.Standard === 'Yes' : null, doubles: row.Doubles ? row.Doubles === 'Yes' : null, sourceRefs: ['littlebuddy18.4'] }, sourceIdentityVerified: true,
      unknownFields: ['relativeWeight', 'actualProbability', 'completeOfferingEligibility', 'cooldownVariantSharing', ...(parsed.unparsed.length ? ['structuredSpecialConditions'] : []), ...(!roundWindow ? ['roundWindow'] : []), ...(hpLimited ? ['health20Eligibility'] : [])], conflicts, sources: [rowSource, sources[1]], ...(traitSource ? { traitMappingSource: traitSource } : {}) } };
  };
  const normalizedEntries = entries.map(entry => normalizeRow(entry, actual.get(entry.id)));
  const ids = new Set(entries.map(entry => entry.id)), excludedSourceRows = rows.filter(row => !ids.has(row.mName)).map(row => ({ id: row.mName, name: row.Name, ...normalizeRow({ id: row.mName }, row), reason: 'not_in_current_mechanic_catalog', membershipVerified: false }));
  const mapped = normalizedEntries.filter(row => row.offeringConditions.sourceIdentityVerified);
  return { schemaVersion: 1, status: 'cached', delivery: 'version_cache', cacheKey, context, entityFingerprint: entityFingerprint(entries), source: sources[0], sources, rules, entries: normalizedEntries,
    coverage: { currentEntities: entries.length, sourceRows: rows.length, mapped: mapped.length, missing: entries.length - mapped.length, specialConditions: mapped.filter(row => row.offeringConditions.sourceText).length,
      cooldownMapped: mapped.filter(row => row.offeringConditions.cooldown).length, roundWindowMapped: mapped.filter(row => row.offeringConditions.roundWindow).length,
      withAugmentExclusions: mapped.filter(row => row.offeringConditions.excludedBy.length).length, unresolvedStructuredConditions: mapped.filter(row => row.offeringConditions.offerConditions.unparsed.length).length,
      boundaryConflicts: mapped.filter(row => row.offeringConditions.conflicts.some(conflict => conflict.type === 'boundary_conflict')).length, excludedSourceRows: excludedSourceRows.length, weightVerified: 0, probabilityVerified: 0, complete: false }, excludedSourceRows,
    reason: '出现限制按18.4来源记录，不保证符合部分条件就一定出现；权重、实际概率与全量资格仍未知。' };
}

export async function readOfferingConditionsSnapshot(catalog, entries, dir = CONDITIONS_DIR) {
  const cacheKey = cacheKeyFor(catalog), context = cacheContext(catalog), manifest = await optionalJSON(new URL(`conditions/${cacheKey}/manifest.json`, dir));
  if (!manifest || manifest.schemaVersion !== 1 || manifest.cacheKey !== cacheKey || stableJSON(manifest.context) !== stableJSON(context) || !/^[a-f0-9-]{36}\.json$/.test(manifest.file) || (entries && manifest.entityFingerprint !== entityFingerprint(entries))) return null;
  const payload = await optionalJSON(new URL(`conditions/${cacheKey}/${manifest.file}`, dir));
  if (!payload || payload.schemaVersion !== 1 || payload.cacheKey !== cacheKey || stableJSON(payload.context) !== stableJSON(context) || sha256(payload) !== manifest.sha256 || payload.entityFingerprint !== manifest.entityFingerprint || !Array.isArray(payload.entries) || payload.entries.some(row => !/^[A-Za-z0-9_]+$/.test(row.id ?? '') || !row.offeringConditions) || new Set(payload.entries.map(row => row.id)).size !== payload.entries.length || entityFingerprint(payload.entries) !== manifest.entityFingerprint || (entries && payload.entries.length !== entries.length)) return null;
  return { payload, manifest };
}
export async function publishOfferingConditionsSnapshot(catalog, entries, payload, raw, dir = CONDITIONS_DIR) {
  if (payload.cacheKey !== cacheKeyFor(catalog) || stableJSON(payload.context) !== stableJSON(cacheContext(catalog)) || payload.entityFingerprint !== entityFingerprint(entries) || entityFingerprint(payload.entries) !== payload.entityFingerprint || new Set(payload.entries.map(row => row.id)).size !== payload.entries.length || payload.source.csvSha256 !== sha256(raw.csv) || payload.source.htmlSha256 !== sha256(raw.littleBuddyHTML) || payload.sources.find(source => source.id === 'riot18.4')?.htmlSha256 !== sha256(raw.riotHTML)) throw new Error('Offering snapshot source/context integrity failed.');
  const capture = randomUUID(), versionDir = new URL(`conditions/${payload.cacheKey}/`, dir), rawDir = new URL(`raw/conditions/${payload.cacheKey}/`, dir); await mkdir(versionDir, { recursive: true }); await mkdir(rawDir, { recursive: true });
  for (const [name, content] of Object.entries(raw)) await writeFile(new URL(`${capture}-${name}.${name === 'csv' ? 'csv' : 'html'}`, rawDir), content);
  const file = `${capture}.json`; await writeFile(new URL(file, versionDir), JSON.stringify(payload, null, 2));
  if (sha256(await optionalJSON(new URL(file, versionDir))) !== sha256(payload)) throw new Error('Offering snapshot disk integrity failed.');
  const manifest = { schemaVersion: 1, cacheKey: payload.cacheKey, context: payload.context, entityFingerprint: payload.entityFingerprint, file, sha256: sha256(payload), fetchedAt: payload.source.fetchedAt, publishedAt: new Date().toISOString(), sourcePatch: PATCH, coverage: payload.coverage };
  const next = new URL(`manifest.${capture}.next.json`, versionDir); await writeFile(next, JSON.stringify(manifest, null, 2)); await rename(next, new URL('manifest.json', versionDir)); return manifest;
}
export async function getMechanicOfferingConditions({ catalog, entries, dir = CONDITIONS_DIR } = {}) {
  catalog ??= await (await import('./data.mjs')).getCatalog();
  const cached = await readOfferingConditionsSnapshot(catalog, entries, dir); if (cached) return cached.payload;
  return { status: 'not_cached', code: 'not_cached', delivery: 'version_cache', cacheKey: cacheKeyFor(catalog), context: cacheContext(catalog), source: null, sources: [], rules: [], entries: [], coverage: { currentEntities: entries?.length ?? null, mapped: 0, complete: false }, reason: '当前版本法杖出现条件未收录或来源/版本校验失败；不会运行时联网。请独立运行 sync:mechanics-conditions。' };
}
