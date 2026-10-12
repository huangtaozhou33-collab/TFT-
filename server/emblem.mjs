// A local roster suggestion, not an equipment legality or win-rate model.
// Only an actual source row with this emblem on this holder counts as observed.
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const family = unit => unit.name.replace(/\s*[（(].*$/, '');
const unitView = (unit, holderId) => ({ id: unit.id, name: unit.name, cost: unit.cost, traits: [...(unit.traits || [])], holdsEmblem: unit.id === holderId });
const thresholds = trait => [...new Set((trait.effects || []).map(effect => effect.minUnits).filter(value => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b);

function countTraits(team, item, traits) {
  const counts = new Map();
  for (const unit of team) for (const name of new Set(unit.traits)) counts.set(name, (counts.get(name) || 0) + 1);
  if (item.traitName && team.some(unit => unit.holdsEmblem && !unit.traits.includes(item.traitName))) counts.set(item.traitName, (counts.get(item.traitName) || 0) + 1);
  return traits.filter(trait => counts.has(trait.name)).map(trait => ({ id: trait.id, name: trait.name, count: counts.get(trait.name), activeThreshold: thresholds(trait).filter(value => value <= counts.get(trait.name)).at(-1) || 0 })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function chooseSource(rows) {
  const reliable = rows.filter(deck => number(deck.stats?.sampleSize) >= 100 && number(deck.stats?.avgPlacement) !== null);
  return (reliable.length ? reliable.sort((a, b) => a.stats.avgPlacement - b.stats.avgPlacement || b.stats.sampleSize - a.stats.sampleSize) : rows.sort((a, b) => (number(b.stats?.sampleSize) || 0) - (number(a.stats?.sampleSize) || 0)))[0];
}

export function recommendEmblemTeam({ itemId, championId, teamSize = 8 } = {}, catalog, decksResult = { data: [] }) {
  const unavailable = reason => ({ status: 'unavailable', reason, team: [], evidenceKind: null });
  const item = catalog?.items?.find(entry => entry.id === itemId);
  const holder = catalog?.champions?.find(entry => entry.id === championId);
  if (!item || item.category !== 'emblem') return unavailable('请选择当前版本的转职纹章。');
  if (!holder) return unavailable('持有者不在当前版本英雄目录中。');
  if (![6, 7, 8, 9, 10].includes(teamSize)) return unavailable('模拟队伍人数需为 6 至 10 的整数。');
  const trait = catalog.traits.find(entry => item.traitId ? entry.id === item.traitId : item.name === `${entry.name}纹章`);
  if (!trait) return unavailable('该纹章的目标羁绊未能从来源映射，暂不生成模拟阵容。');
  const selectedItem = { id: item.id, name: item.name, traitId: trait.id, traitName: trait.name };
  const selectedHolder = { id: holder.id, name: holder.name, cost: holder.cost };
  const champions = new Map(catalog.champions.map(unit => [unit.id, unit]));
  const matching = (decksResult.data || []).filter(deck => Array.isArray(deck.units) && deck.units.length > 0 && deck.units.length <= 12
    && deck.units.every(unit => champions.has(unit.id))
    && new Set(deck.units.map(unit => family(champions.get(unit.id)))).size === deck.units.length
    && deck.units.some(unit => unit.id === holder.id && unit.items?.includes(item.id)));
  if (matching.length) {
    const deck = chooseSource(matching);
    const team = deck.units.map(unit => unitView(champions.get(unit.id), holder.id));
    return { status: 'source_match', item: selectedItem, holder: selectedHolder, team, traits: countTraits(team, selectedItem, catalog.traits), teamSize: team.length,
      sourceDeck: { id: deck.id, name: deck.name, stats: deck.stats, evidence: deck.evidence || decksResult.evidence }, evidenceKind: 'observed_emblem_deck', reason: null,
      holderItems: [...deck.units.find(unit => unit.id === holder.id).items], note: '此来源阵容明确包含该英雄携带所选纹章；统计只属于来源阵容。' };
  }
  if (holder.traits.includes(trait.name)) return unavailable(`${holder.name}已有${trait.name}羁绊，不建议再给它这个转职。`);

  const team = [holder];
  const selectedFamilies = new Set([family(holder)]);
  const candidates = catalog.champions.filter(unit => unit.id !== holder.id);
  const native = candidates.filter(unit => unit.traits.includes(trait.name) && !selectedFamilies.has(family(unit)));
  const nativeFamilies = new Set(native.map(family));
  const target = thresholds(trait).filter(value => value <= Math.min(teamSize, nativeFamilies.size + 1)).at(-1) || 1;
  const score = unit => {
    const before = countTraits(team.map(entry => unitView(entry, holder.id)), selectedItem, catalog.traits);
    const after = countTraits([...team, unit].map(entry => unitView(entry, holder.id)), selectedItem, catalog.traits);
    const prior = new Map(before.map(row => [row.id, row]));
    return after.reduce((value, row) => value + (row.activeThreshold > (prior.get(row.id)?.activeThreshold || 0) ? 12 : 0), 0)
      + unit.traits.filter(name => holder.traits.includes(name)).length * 4 + unit.cost;
  };
  while (team.length < teamSize) {
    const targetCount = team.filter(unit => unit.traits.includes(trait.name)).length + 1;
    const remaining = candidates.filter(unit => !selectedFamilies.has(family(unit)));
    const pool = targetCount < target ? remaining.filter(unit => unit.traits.includes(trait.name)) : remaining;
    if (!pool.length) break;
    const next = pool.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
    team.push(next); selectedFamilies.add(family(next));
  }
  const resultTeam = team.map(unit => unitView(unit, holder.id));
  return { status: 'simulation', item: selectedItem, holder: selectedHolder, team: resultTeam, traits: countTraits(resultTeam, selectedItem, catalog.traits), teamSize: resultTeam.length,
    evidenceKind: 'trait_simulation', reason: null, note: '模拟搭配：按当前英雄标签与羁绊档位补队友；没有此转职阵容的实测胜率，不校验特殊装备兼容或用户库存。特殊计数机制未模拟。' };
}
