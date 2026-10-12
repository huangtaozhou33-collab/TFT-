// Browse documented offering windows; this does not predict a random shop roll.
const roundNumber = value => {
  const match = /^(\d{1,2})-([1-7])$/.exec(String(value ?? ''));
  return match && Number(match[1]) > 0 ? Number(match[1]) * 10 + Number(match[2]) : null;
};
const inWindows = (windows, round) => Array.isArray(windows) && windows.some(window => {
  const from = roundNumber(window.from), to = roundNumber(window.to);
  return from != null && to != null && from <= round && round <= to;
});
export function offeringWindowAt(entry, round) {
  const value = roundNumber(round), conditions = entry?.offeringConditions;
  if (value == null || !['documented', 'partial'].includes(conditions?.status) || !conditions.roundWindow?.length) return 'unknown';
  const inside = inWindows(conditions.roundWindow, value);
  const variants = (conditions.conflicts || []).filter(conflict => conflict.field === 'roundWindow')
    .flatMap(conflict => [conflict.riotValue, conflict.littleBuddyValue]).filter(Array.isArray);
  if (variants.some(windows => inWindows(windows, value) !== inside)) return 'conflict';
  return inside ? 'inside' : 'outside';
}
export function offeringPreview(entry) {
  const conditions = entry?.offeringConditions;
  if (!['documented', 'partial'].includes(conditions?.status)) return { recorded: false, window: '出现回合未收录', conditions: ['此形态的条件尚未收录'], cost: null, cooldown: null };
  const window = conditions.roundWindow?.map(range => `${range.from} — ${range.to}`).join(' / ') || '出现回合未收录';
  const cost = conditions.purchaseConditions?.cost;
  const cooldown = conditions.cooldown;
  return { recorded: true, window, conditions: conditions.conditionsText || [],
    cost: cost?.unit === 'gold' && Number.isFinite(cost.value) ? cost.value : null,
    cooldown: cooldown?.unit === 'wisp_shops' && cooldown.trigger === 'offered' && Number.isFinite(cooldown.value) ? cooldown.value : null };
}
export function mechanicSearchText(entry) {
  const conditions = entry.offeringConditions || {};
  return ['法杖 Wisp 出现条件', entry.name, entry.nameEn, entry.description, entry.categoryName, ...(entry.conditions || []),
    ...(conditions.conditionsText || []), offeringPreview(entry).window, ...(conditions.excludedBy || []).map(augment => augment.name)]
    .join(' ').normalize('NFKC').toLowerCase().replace(/\s/g, '');
}
