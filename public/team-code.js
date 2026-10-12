// PC native team-planner format: champion slots and a mutator identifier.
// No browser, filesystem or network dependency; mapping is supplied by the caller.
export class TeamCodeError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'TeamCodeError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new TeamCodeError(code, message, status); };
const includes = () => ({ champions: true, items: false, positions: false, stars: false });
const contextKeys = ['game', 'set', 'mutator', 'assetVersion', 'rulesVersion', 'gamePatch'];
const contextIdentity = context => JSON.stringify(contextKeys.map(key => context?.[key] ?? null));

function requireMapping(mapping, currentContext) {
  if (!mapping || mapping.schemaVersion !== 1 || !mapping.context || !Array.isArray(mapping.entries) || !mapping.entries.length || !mapping.v1 || !mapping.v2) fail('mapping_invalid', '本地PC阵容码映射结构无效。', 503);
  if (contextIdentity(mapping.context) !== contextIdentity(currentContext)) fail('set_mismatch', '阵容码映射版本与当前赛季、资产或规则版本不一致。');
  if (mapping.context.game !== 'tft' || !Number.isSafeInteger(mapping.context.set) || !/^TFTSet\d+(?:_Act\d+)?$/.test(mapping.context.mutator ?? '')) fail('mapping_invalid', 'PC阵容码映射缺少可验证的赛季标识。', 503);
  const entries = new Map();
  for (const row of mapping.entries) {
    if (!row || !/^[A-Za-z0-9_]+$/.test(row.championId ?? '') || entries.has(row.championId) || !Number.isSafeInteger(row.v1) || row.v1 < 1 || row.v1 > 255 || !Number.isSafeInteger(row.v2) || row.v2 < 1 || row.v2 > 4095 || mapping.v1[row.v1] !== row.championId || mapping.v2[row.v2] !== row.championId) fail('mapping_invalid', 'PC阵容码映射存在重复或不一致的棋子编号。', 503);
    entries.set(row.championId, row);
  }
  if (Object.keys(mapping.v1).length !== entries.size || Object.keys(mapping.v2).length !== entries.size) fail('mapping_invalid', 'PC阵容码映射存在未验证的额外编号。', 503);
  return entries;
}

function parseCode(input) {
  if (typeof input !== 'string' || input.trim().length > 100) fail('invalid_code', '请输入PC原生阵容码文本。');
  const match = /^([0-9a-f]{2})([0-9a-f]+)(TFTSet\d+(?:_Act\d+)?)$/i.exec(input.trim());
  if (!match) fail('invalid_code', '阵容码格式无效；需要十六进制棋子编码和TFTSet赛季后缀。');
  const [, prefix, hex, mutator] = match;
  if (!['01', '02'].includes(prefix)) fail('unsupported_format', '当前仅支持PC原生01/02格式，不支持其他格式或移动端专用码。');
  const version = prefix === '02' ? 2 : 1, chunkSize = version === 2 ? 3 : 2;
  if (hex.length !== chunkSize * 10) fail('invalid_slot_count', 'PC原生阵容码必须包含10个棋子槽；空槽也必须保留。');
  return { version, prefix, hex: hex.toLowerCase(), mutator, chunks: Array.from({ length: 10 }, (_, index) => hex.slice(index * chunkSize, (index + 1) * chunkSize).toLowerCase()) };
}

export function decodePCCode(code, mapping, currentContext) {
  const parsed = parseCode(code), entries = requireMapping(mapping, currentContext);
  if (parsed.mutator.toLowerCase() !== currentContext.mutator.toLowerCase()) fail('set_mismatch', '阵容码所属赛季/模式与当前标准赛季不匹配。');
  const units = [];
  parsed.chunks.forEach((chunk, index) => {
    const number = Number.parseInt(chunk, 16); if (number === 0) return;
    const championId = mapping[`v${parsed.version}`][number], champion = entries.get(championId);
    if (!champion) fail('unknown_champion_code', `第${index + 1}槽的棋子编号未在当前版本PC映射中收录；不能静默跳过或猜测英雄。`);
    units.push({ instanceId: `pc-${currentContext.mutator}-${index + 1}`, championId, name: champion.name, cost: champion.cost, icon: champion.icon ?? null,
      items: [], cell: null, star: 1, starOrigin: 'editor_default_not_encoded', codeSlot: index + 1 });
  });
  return { status: 'ready', format: 'riot_pc', platform: 'pc', code: `${parsed.prefix}${parsed.hex}${currentContext.mutator}`, version: parsed.version,
    context: { ...currentContext }, set: currentContext.set, mutator: currentContext.mutator, capacity: 10, units, includes: includes(),
    warnings: [{ code: 'native_fields_limited', message: '原生码仅承载棋子槽位和赛季标识，不含装备、站位或星级。' },
      { code: 'star_default_not_encoded', message: '星级1仅为编辑器默认值，不能当作码中记录的实际星级。' },
      { code: 'population_not_encoded', message: '基础人口由当前目录规则计算；原生码不记录玩家等级或额外队伍容量，英雄费用不是人口。' }],
    ...(units.length ? {} : { empty: true }) };
}

export function encodePCCode(units, mapping, currentContext, { version = 2 } = {}) {
  const entries = requireMapping(mapping, currentContext);
  if (![1, 2].includes(version)) fail('unsupported_format', '当前仅支持PC原生01/02格式。');
  if (!Array.isArray(units) || units.length > 10) fail('invalid_slot_count', 'PC原生码最多保存10个棋子条目。');
  const width = version === 2 ? 3 : 2, encoded = units.map((unit, index) => {
    const championId = typeof unit === 'string' ? unit : unit?.championId;
    const row = entries.get(championId);
    if (!row) fail('unsupported_champion', `第${index + 1}个棋子未在当前PC映射中收录；不会猜测变体或别名。`);
    return row[`v${version}`].toString(16).padStart(width, '0');
  });
  while (encoded.length < 10) encoded.push('0'.repeat(width));
  return { format: 'riot_pc', platform: 'pc', version, code: `${version === 2 ? '02' : '01'}${encoded.join('')}${currentContext.mutator}`,
    context: { ...currentContext }, set: currentContext.set, mutator: currentContext.mutator, includes: includes(),
    warnings: [{ code: 'native_fields_limited', message: '导出的PC原生码只保存棋子；装备、站位、星级和笔记不会写入该码。' },
      { code: 'client_not_live_tested', message: '格式已与公开实现和版本映射核对；本机未通过真实游戏客户端粘贴验收。' }] };
}
