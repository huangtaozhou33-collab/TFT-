// Curated spelling and nickname aids. These names attach only to catalog rows;
// this is not a general Chinese transliteration engine or an entity generator.
import { COMMUNITY_CHAMPION_ALIASES } from './glossary-aliases.js';
const CHAMPION_NAMES = {
  '阿卡丽': ['a ka li', 'Akali'], '奥恩': ['ao en', 'Ornn', '羊', '山羊'],
  '苍蓝哨戒': ['cang lan shao jie', 'Pebbles', '小蓝'], '绯红树怪': ['fei hong shu guai', 'Cinderling', '小红'],
  '卡尔玛': ['ka er ma', 'Karma', '扇子妈'], '卡蜜尔': ['ka mi er', 'Camille', '青钢影'],
  '可酷伯': ['ke ku bo', 'Kobuko'], '雷克塞': ['lei ke sai', "Rek'Sai", '挖掘机'],
  '蕾欧娜': ['lei ou na', 'Leona', '日女', '曙光'], '洛': ['luo', 'Rakan'],
  '韦鲁斯': ['wei lu si', 'Varus'], '维迦': ['wei jia', 'Veigar', '小法', '小法师'],
  '霞': ['xia', 'Xayah'], '约里克': ['yue li ke', 'Yorick', '掘墓'],
  '阿利斯塔': ['a li si ta', 'Alistar', '牛头'], '暗影狼': ['an ying lang', 'Murkwolf', '狼'],
  '凯尔': ['kai er', 'Kayle', '天使'], '凯特琳': ['kai te lin', 'Caitlyn', '女警'],
  '乐芙兰': ['le fu lan', 'LeBlanc', '妖姬'], '魔沼蛙': ['mo zhao wa', 'Gromp', '蛤蟆'],
  '瑟庄妮': ['se zhuang ni', 'Sejuani', '猪妹'], '慎': ['shen', 'Shen'],
  '提莫': ['ti mo', 'Teemo'], '沃里克': ['wo li ke', 'Warwick', '狼人'],
  '峡谷迅捷蟹': ['xia gu xun jie xie', 'Scuttlecrab', '河蟹'], '伊莉丝': ['yi li si', 'Elise', '蜘蛛'],
  '芸阿娜': ['yun a na', 'Yunara'], '阿兹尔': ['a zi er', 'Azir', '沙皇'],
  '崔丝塔娜': ['cui si ta na', 'Tristana', '小炮'], '黛安娜': ['dai an na', 'Diana', '皎月'],
  '费德提克': ['fei de ti ke', 'Fiddlesticks', '稻草人'], '赫卡里姆': ['he ka li mu', 'Hecarim', '人马'],
  '卡西奥佩娅': ['ka xi ao pei ya', 'Cassiopeia', '蛇女'], '卡兹克': ['ka zi ke', "Kha'Zix", '螳螂'],
  '克格莫': ['ke ge mo', "Kog'Maw", '大嘴'], '拉莫斯': ['la mo si', 'Rammus', '龙龟'],
  '雷恩加尔': ['lei en jia er', 'Rengar', '狮子狗'], '深红锋喙鸟': ['shen hong feng hui niao', 'Mama Beak', '大鸟'],
  '蔚': ['wei', 'Vi'], '易': ['yi', 'Master Yi', '剑圣', 'js'],
  '远古石甲虫': ['yuan gu shi jia chong', 'Krug', '石头人野怪'], '阿狸': ['a li', 'Ahri', '狐狸'],
  '阿木木': ['a mu mu', 'Amumu', '木木'], '苍蓝雕纹魔像': ['cang lan diao wen mo xiang', 'Sentinel', '蓝buff', '蓝爸爸'],
  '厄斐琉斯': ['e fei liu si', 'Aphelios', '月男'], '绯红印记树怪': ['fei hong yin ji shu guai', 'Brambleback', '红buff', '红爸爸'],
  '婕拉': ['jie la', 'Zyra', '植物'], '莉莉娅': ['li li ya', 'Lillia', '小鹿'],
  '莫甘娜': ['mo gan na', 'Morgana', '莫甘'], '墨菲特': ['mo fei te', 'Malphite', '石头人'],
  '奈德丽': ['nai de li', 'Nidalee', '豹女'], '瑟提': ['se ti', 'Sett', '腕豪'],
  '索拉卡': ['suo la ka', 'Soraka', '奶妈'], '希维尔': ['xi wei er', 'Sivir', '轮子妈'],
  '伊泽瑞尔': ['yi ze rui er', 'Ezreal', 'ez'], '艾翁': ['ai weng', 'Ivern', '翠神'],
  '艾希': ['ai xi', 'Ashe', '寒冰'], '德莱文': ['de lai wen', 'Draven', '德子'],
  '凯南': ['kai nan', 'Kennen'], '拉克丝': ['la ke si', 'Lux', '光辉', '光女'],
  '拉露恩': ['la lu en', 'Alune'], '茂凯': ['mao kai', 'Maokai', '大树', '树精', 'dashu'],
  '纳尔': ['na er', 'Gnar'], '塔里克': ['ta li ke', 'Taric', '宝石'],
  '远古巨龙': ['yuan gu ju long', 'Elder Dragon', '大龙'],
};

// Exact current Chinese names keep core nicknames away from radiant variants.
const ITEM_NAMES = {
  '鬼索的狂暴之刃': ['羊刀', '鬼索', 'yd'], '珠光护手': ['法爆', '法爆拳', 'fb'],
  '石像鬼石板甲': ['板甲', '石像鬼', 'bj'], '朔极之矛': ['青龙刀', '青龙', 'qld'],
  '蓝霸符': ['蓝buff', '蓝buff装', '蓝霸服'], '红霸符': ['红buff', '红霸服'],
  '灭世者的死亡之帽': ['帽子', '大帽', '法帽'], '莫雷洛秘典': ['鬼书', '重伤书'],
  '海克斯科技枪刃': ['科技枪', '枪刃'], '饮血剑': ['饮血', '吸血剑'],
  '最后的轻语': ['轻语'], '无尽之刃': ['无尽'], '死亡之刃': ['杀人剑'],
  '巨龙之爪': ['龙牙'], '棘刺背心': ['反甲'], '狂徒铠甲': ['狂徒'],
  '日炎斗篷': ['日炎', '火甲'], '离子火花': ['离子'], '大天使之杖': ['大天使'],
  '泰坦的坚决': ['泰坦'], '正义之手': ['正义'], '夜之锋刃': ['夜刃', '锋刃'],
  '窃贼手套': ['偷偷', '偷子', '贼手套'], '纳什之牙': ['纳什'], '巨人杀手': ['巨杀'],
  '斯特拉克的挑战护手': ['血手'], '薄暮法袍': ['薄暮'], '海妖之怒': ['海妖'],
  '振奋盔甲': ['振奋'], '圣盾使的誓约': ['圣盾', '誓约'], '疾射火炮': ['火炮'],
  '智慧末刃': ['智慧'], '三相之力': ['三相'], '中娅悖论': ['中娅', '金身'],
  '斯塔缇克电刃': ['电刀'], '暴风大剑': ['大剑'], '反曲之弓': ['反曲弓', '弓'],
  '无用大棒': ['大棒'], '女神之泪': ['眼泪', '水滴'], '锁子甲': ['锁甲'],
  '负极斗篷': ['斗篷'], '巨人腰带': ['腰带'], '拳套': ['手套'], '金铲铲': ['铲子'],
};

const TRAIT_PINYIN = {
  '永恒之森': 'yong heng zhi sen', '狂战士': 'kuang zhan shi', '魔战士': 'mo zhan shi',
  '魔女': 'mo nv', '猎人': 'lie ren', '神谕': 'shen yu', '迅捷射手': 'xun jie she shou',
  '主宰': 'zhu zai', '地狱火': 'di yu huo', '宿敌': 'su di', '重装战士': 'zhong zhuang zhan shi',
  '斗士': 'dou shi', '黑荆棘': 'hei jing ji', '裁决使': 'cai jue shi', '峡谷野怪': 'xia gu ye guai',
  '花仙子': 'hua xian zi', '月蚀骑士': 'yue shi qi shi', '日蚀骑士': 'ri shi qi shi',
  '护卫': 'hu wei', '法师': 'fa shi', '召唤师': 'zhao huan shi', '灵魂莲华': 'ling hun lian hua',
  '野兽之灵': 'ye shou zhi ling', '约德尔人和朋友': 'yue de er ren he peng you',
};
const TYPE_ORDER = { champion: 0, item: 1, trait: 2 };
const TYPES = { champion: 'champion', champions: 'champion', item: 'item', items: 'item', trait: 'trait', traits: 'trait' };
const strings = values => Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
function normalizeText(value) {
  return String(value || '').normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
}
function pinyinForms(spelling) {
  if (!spelling) return [];
  const syllables = spelling.split(/\s+/).filter(Boolean);
  return [syllables.join(''), syllables.map(syllable => syllable[0]).join('')];
}
function championForms(entity) {
  const baseName = entity.name?.replace(/\s*[（(].*[）)]\s*$/, '');
  const known = CHAMPION_NAMES[entity.name] || (baseName === '拉克丝' ? CHAMPION_NAMES[baseName] : null);
  return known ? [known[0], ...pinyinForms(known[0]), ...known.slice(1)] : [];
}

/** Names are attached to a real catalog row. Never infer an ID from a nickname. */
export function getEntityAliases(entity, type) {
  if (!entity || typeof entity.name !== 'string') return [];
  let extra = [];
  if (type === 'champion') extra = [...championForms(entity), ...(COMMUNITY_CHAMPION_ALIASES[entity.name] || [])];
  else if (type === 'trait') extra = pinyinForms(TRAIT_PINYIN[entity.name]);
  else if (type === 'item') {
    const radiant = entity.category === 'radiant' || /^光明(?:版)?/.test(entity.name);
    const base = entity.name.replace(/^光明(?:版)?/, '');
    extra = radiant ? [base, ...(ITEM_NAMES[base] || [])].flatMap(alias => [`光明${alias}`, `光明版${alias}`]) : ITEM_NAMES[entity.name] || [];
    if (entity.category === 'emblem' || /纹章$/.test(entity.name)) {
      extra = [...extra, entity.name.replace(/纹章$/, '转职'), entity.name.replace(/纹章$/, '转')];
    }
  }
  return [...new Set([...strings(entity.aliases), ...strings([entity.nameEn, entity.englishName]), ...extra])];
}

/** Build once per catalog. Returned matches retain each real entity and ID. */
export function buildExplorerIndex(catalog = {}) {
  if (!catalog || typeof catalog !== 'object') catalog = {};
  const index = { schemaVersion: 1, entries: [], champion: new Map(), item: new Map(), trait: new Map() };
  const traits = Array.isArray(catalog.traits) ? catalog.traits : [];
  const traitById = new Map(traits.filter(entity => entity && typeof entity.id === 'string').map(entity => [entity.id, entity]));
  const traitByName = new Map(traits.filter(entity => entity && typeof entity.name === 'string').map(entity => [entity.name, entity]));
  for (const [type, key] of [['champion', 'champions'], ['item', 'items'], ['trait', 'traits']]) {
    const entities = Array.isArray(catalog[key]) ? catalog[key] : [];
    for (const entity of entities) {
      if (!entity || typeof entity.id !== 'string' || !entity.id || typeof entity.name !== 'string' || index[type].has(entity.id)) continue;
      const aliases = getEntityAliases(entity, type);
      const nativeTraits = type === 'champion' ? strings(entity.traits).flatMap(value => {
        const trait = traitById.get(value) || traitByName.get(value);
        const name = trait?.name || value;
        return [name, ...strings(trait?.aliases), ...pinyinForms(TRAIT_PINYIN[name])];
      }) : [];
      const cost = type === 'champion' && typeof entity.cost === 'number' && Number.isFinite(entity.cost) ? entity.cost : null;
      const ownForms = [...new Set([entity.name, ...aliases].map(normalizeText).filter(Boolean))];
      const traitForms = [...new Set(nativeTraits.map(normalizeText).filter(Boolean))];
      const mentionForms = [...new Set([entity.name, entity.id, ...aliases])];
      index.entries.push({ type, entity, ownForms, mentionForms, nameForm: normalizeText(entity.name), traitForms, cost, position: index.entries.length });
      // Compatible with the explorer row filter's entity maps, without mutation.
      index[type].set(entity.id, { ...entity, aliases: [...aliases, ...nativeTraits, ...(cost == null ? [] : [`${cost}费`])] });
    }
  }
  return index;
}

/** Searches names, curated aliases, native traits and an optional hero cost. */
export function searchExplorerEntities(index, text, type = '') {
  if (!index || !Array.isArray(index.entries) || typeof text !== 'string' || !text.trim()) return [];
  const selectedType = type ? TYPES[type] : null;
  if (type && !selectedType) return [];
  const costs = [...text.matchAll(/([1-9])\s*费/g)].map(match => Number(match[1]));
  if (new Set(costs).size > 1) return [];
  const cost = costs[0] ?? null;
  const remaining = text.replace(/([1-9])\s*费/g, ' ').trim();
  const query = normalizeText(remaining);
  const tokens = remaining.split(/[\s,，、]+/).map(normalizeText).filter(Boolean);
  const ordinaryExact = index.entries.some(entry => entry.type === 'item' && entry.entity.category !== 'radiant' && !/^光明/.test(entry.entity.name) && entry.ownForms.includes(query));
  return index.entries.flatMap(entry => {
    if (selectedType && entry.type !== selectedType || cost != null && (entry.type !== 'champion' || entry.cost !== cost)) return [];
    if (ordinaryExact && !/^光明|^radiant/i.test(query) && entry.type === 'item' && (entry.entity.category === 'radiant' || /^光明/.test(entry.entity.name))) return [];
    const own = entry.ownForms, traits = entry.traitForms;
    let rank = 5; let matchKind = cost != null ? 'cost' : 'name';
    if (query) {
      if (entry.nameForm === query) rank = 0;
      else if (own.includes(query)) { rank = 1; matchKind = 'alias'; }
      else if (own.some(value => value.startsWith(query))) rank = 2;
      else if (own.some(value => value.includes(query))) rank = 3;
      else if (traits.some(value => value.includes(query))) { rank = 4; matchKind = 'native_trait'; }
      else if (tokens.length > 1 && tokens.every(token => [...own, ...traits].some(value => value.includes(token)))) { rank = 4; matchKind = 'terms'; }
      else return [];
    }
    return [{ type: entry.type, entity: entry.entity, matchKind, rank, position: entry.position }];
  }).sort((a, b) => a.rank - b.rank || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.position - b.position).map(({ type: matchedType, entity, matchKind }) => ({ type: matchedType, entity, matchKind }));
}

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Exact entity mentions for chat and intent parsing. Longest spans win;
 * same-span candidates remain explicit instead of choosing an arbitrary ID. */
export function matchEntityMentions(index, text, type = '') {
  if (!index?.entries || typeof text !== 'string' || !text.trim()) return [];
  const selectedType = type ? TYPES[type] : null;
  if (type && !selectedType) return [];
  const candidates = [];
  for (const entry of index.entries) {
    if (selectedType && entry.type !== selectedType) continue;
    for (const alias of entry.mentionForms || [entry.entity.name, entry.entity.id]) {
      if (!alias) continue;
      const ascii = /^[\x00-\x7f]+$/.test(alias);
      const expression = escapePattern(alias).replace(/\s+/g, '\\s+');
      const pattern = ascii ? `(^|[^a-z0-9_])(${expression})(?=$|[^a-z0-9_])` : `(${expression})`;
      for (const match of text.matchAll(new RegExp(pattern, 'gi'))) {
        const start = match.index + (ascii ? match[1].length : 0);
        const matched = ascii ? match[2] : match[1], end = start + matched.length;
        // Single-character aliases must be standalone or clearly used as a unit.
        if (alias.length === 1 && /\p{Script=Han}/u.test(alias)
          && !/(?:^|[\s,，、+＋和与及给让])$/.test(text.slice(0, start))
          && !/^(?:的|带|携带|出装|装备|三件套|同时上场)/.test(text.slice(end))) continue;
        if (alias.length === 1 && /\p{Script=Han}/u.test(alias)
          && !/^(?:$|[\s,，、。？?+＋和与及的]|带|携带|出装|装备|三件套|同时上场)/.test(text.slice(end))) continue;
        // An unavailable radiant version must not quietly resolve to the core item.
        if (entry.type === 'item' && entry.entity.category !== 'radiant' && !/^光明/.test(entry.entity.name)
          && /(?:光明(?:版)?\s*|radiant\s+)$/i.test(text.slice(0, start))) continue;
        candidates.push({ start, end, type: entry.type, entity: entry.entity, alias: matched });
      }
    }
  }
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const spans = [];
  for (const candidate of candidates) {
    const same = spans.find(span => span.start === candidate.start && span.end === candidate.end);
    if (same) {
      if (!same.candidates.some(row => row.type === candidate.type && row.entity.id === candidate.entity.id)) same.candidates.push(candidate);
    } else if (!spans.some(span => candidate.start < span.end && candidate.end > span.start)) {
      spans.push({ start: candidate.start, end: candidate.end, text: text.slice(candidate.start, candidate.end), candidates: [candidate] });
    }
  }
  return spans.sort((a, b) => a.start - b.start).map(span => ({ ...span, ambiguous: span.candidates.length > 1 }));
}

/** Tool searches can list several entities; frontend filters keep their AND search. */
export function searchCatalogEntities(index, text, type = '') {
  const combined = searchExplorerEntities(index, text, type);
  if (combined.length) return combined;
  const rows = matchEntityMentions(index, text, type).flatMap(span => span.candidates.map(row => ({ type: row.type, entity: row.entity, matchKind: span.ambiguous ? 'ambiguous_alias' : 'alias' })));
  for (const token of String(text || '').split(/[\s,，、]+/).filter(Boolean)) rows.push(...searchExplorerEntities(index, token, type));
  return [...new Map(rows.map(row => [`${row.type}:${row.entity.id}`, row])).values()];
}
