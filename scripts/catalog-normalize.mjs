function hashName(name) {
  let hash = 0x811c9dc5;
  for (const char of name.toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 0x1000193) >>> 0;
  return `{${hash.toString(16).padStart(8, '0')}}`;
}

function numberText(value) { return Number.isFinite(value) ? String(Number(value.toFixed(3))) : null; }

// Substitute only values present in the source. Dynamic game formulas remain unknown.
export function cleanText(input, variables = {}) {
  const vars = new Map(Object.entries(variables).map(([key, value]) => [key.toLowerCase(), value]));
  const unknown = new Set();
  let text = String(input ?? '').replace(/\\r\\n/g, '\n').replace(/\\[rn]/g, '\n').replace(/\r/g, '\n').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/row>/gi, '\n').replace(/<[^>]*>/g, '');
  text = text.replace(/@([^@]+)@/g, (_, expression) => {
    const match = /^([\w.{}:]+)(?:\*(\d+(?:\.\d+)?))?$/.exec(expression);
    const key = match?.[1]; const multiplier = Number(match?.[2] ?? 1);
    const value = key ? vars.get(key.toLowerCase()) ?? vars.get(hashName(key).toLowerCase()) : undefined;
    if (value === undefined || value === null) { unknown.add(expression); return '〔数值未知〕'; }
    if (Array.isArray(value)) {
      const starValues = value.length >= 4 ? value.slice(1, 4) : value;
      return [...new Set(starValues.map(number => numberText(number * multiplier)))].filter(Boolean).join(' / ') || '〔数值未知〕';
    }
    return numberText(Number(value) * multiplier) ?? '〔数值未知〕';
  });
  text = text.replace(/%i:[^%]*%/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '＜').replace(/&gt;/g, '＞').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\{[a-f0-9]{8}\}/gi, '〔字段未知〕').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, incomplete: unknown.size > 0, unresolved: [...unknown] };
}

export function assetURL(path, version) {
  if (!path || path === 'None') return null;
  if (/^https:\/\//.test(path)) return path;
  const normalized = path.toLowerCase().replace(/^\//, '').replace(/\.(tex|dds)$/i, '.png');
  if (!normalized.startsWith('assets/')) return null;
  return `https://raw.communitydragon.org/${version}/game/${normalized}`;
}

export function normalizeCatalog(zh, en, manifest, opggRecipes = null, opggAugments = null) {
  const standardSets = zh.setData.filter(set => set.mutator === `TFTSet${set.number}`);
  const set = standardSets.sort((a, b) => b.number - a.number)[0];
  if (!set) throw new Error('No standard set in the static source.');
  const enSet = en.setData.find(candidate => candidate.mutator === set.mutator);
  if (!enSet) throw new Error('English/Chinese set mismatch.');
  const englishChampions = new Map(enSet.champions.map(champion => [champion.apiName, champion]));
  const englishItems = new Map(en.items.map(item => [item.apiName, item]));
  const allItems = new Map(zh.items.map(item => [item.apiName, item]));
  const setItemIds = new Set(set.items); const setAugmentIds = new Set(set.augments);
  const version = manifest.assetVersion;
  const champions = set.champions.filter(champion => champion.traits.length > 0 && champion.cost >= 1 && champion.cost <= 5).map(champion => {
    const variables = Object.fromEntries((champion.ability?.variables ?? []).map(variable => [variable.name, variable.value]));
    const description = cleanText(champion.ability?.desc, variables);
    return { id: champion.apiName, name: cleanText(champion.name).text, aliases: [englishChampions.get(champion.apiName)?.name].filter(Boolean), cost: champion.cost, traits: champion.traits, role: champion.role ?? null, stats: champion.stats,
      ability: { name: cleanText(champion.ability?.name).text, description: description.text, descriptionIncomplete: description.incomplete, unresolvedVariables: description.unresolved, variables: champion.ability?.variables ?? [] },
      icon: assetURL(champion.squareIcon || champion.tileIcon || champion.icon, version), source: 'communitydragon' };
  }).sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'zh-CN'));
  const usedTraitNames = new Set(champions.flatMap(champion => champion.traits));
  const traits = set.traits.filter(trait => usedTraitNames.has(trait.name)).map(trait => {
    let index = 0; const unresolved = new Set();
    const raw = String(trait.desc ?? '').replace(/<row>([\s\S]*?)<\/row>/g, (_, row) => {
      const effect = trait.effects[index++] ?? {};
      const result = cleanText(row, { ...(effect.variables ?? {}), MinUnits: effect.minUnits });
      result.unresolved.forEach(key => unresolved.add(key)); return `${result.text}\n`;
    });
    const description = cleanText(raw, trait.effects[0]?.variables);
    description.unresolved.forEach(key => unresolved.add(key));
    return { id: trait.apiName, name: trait.name, description: description.text, descriptionIncomplete: unresolved.size > 0, icon: assetURL(trait.icon, version), effects: trait.effects, source: 'communitydragon' };
  });
  // OP.GG's recipe table contains old-set rows; accept only the current standard set intersection.
  const recipeBody = opggRecipes?.body;
  const validRecipeSource = recipeBody?.set === set.number && Array.isArray(recipeBody.data);
  // Current-set artifacts can be missing from CDragon's export. Require both the
  // set-labelled OP.GG response and its explicit native artifact flag; old TFT17
  // / internal rows remain excluded. This adds Death's Defiance, not old Ornn rows.
  const currentRecipes = validRecipeSource ? recipeBody.data.filter(item =>
    (setItemIds.has(item.apiName) || (item.category === 'artifact' && item.org?.isArtifact === true && /^DA_(?:Artifact_|Item_Artifact_)/.test(item.apiName)))
    && ['core', 'component', 'artifact', 'radiant', 'emblem'].includes(item.category)) : [];
  const recipeMap = new Map(currentRecipes.map(item => [item.apiName, item]));
  const itemCandidates = currentRecipes.length ? currentRecipes : set.items.map(id => allItems.get(id)).filter(item => item && !item.isAugment && ((item.tags ?? []).includes('component') || item.composition.length === 2));
  const items = itemCandidates.map(candidate => {
    const item = allItems.get(candidate.apiName) ?? candidate;
    const opgg = recipeMap.get(item.apiName);
    const descriptionSource = item.desc ? (allItems.has(item.apiName) ? 'communitydragon' : 'opgg') : opgg?.desc ? 'opgg' : null;
    const description = cleanText(item.desc || opgg?.desc || '', item.effects);
    const components = item.composition?.length ? item.composition : opgg?.composition ?? [];
    const category = opgg?.category ?? ((item.tags ?? []).includes('component') ? 'component' : 'core');
    const kind = category === 'component' ? 'component' : category === 'core' && components.length === 2 ? 'completed' : 'special';
    const displayName = cleanText(item.name || opgg?.name).text;
    const emblemTrait = category === 'emblem' ? traits.find(trait => displayName === `${trait.name}纹章`) : null;
    return { id: item.apiName, name: displayName, aliases: [englishItems.get(item.apiName)?.name].filter(Boolean), description: description.text || '来源未提供效果说明。', descriptionIncomplete: description.incomplete || !descriptionSource,
      descriptionLanguage: /[\u4e00-\u9fff]/.test(description.text) ? 'zh_cn' : description.text ? 'en_us' : null,
      icon: assetURL(item.icon, version) || opgg?.imageUrl || null, components, kind, category, allocationVerified: kind === 'completed',
      ...(category === 'emblem' ? { traitId: emblemTrait?.id ?? null, traitName: emblemTrait?.name ?? null, traitMapping: emblemTrait ? { method: 'exact_name', sourceItemName: displayName, sourceTraitName: emblemTrait.name, compatibilityVerified: false } : null } : {}),
      unique: Boolean(item.unique || opgg?.unique || opgg?.org?.isUnique), slotCost: /Consumes\s+3\s+item\s+slots/i.test(`${item.desc ?? ''} ${opgg?.desc ?? ''}`) ? 3 : 1,
      associatedTraits: item.associatedTraits ?? [], incompatibleTraits: item.incompatibleTraits ?? [], tags: item.tags ?? [], effects: item.effects ?? {},
      source: { identity: allItems.has(item.apiName) ? 'communitydragon' : 'opgg', membership: setItemIds.has(item.apiName) ? 'communitydragon_standard_set' : 'opgg_explicit_current_set_artifact', description: descriptionSource, recipe: components.length ? (item.composition?.length ? 'communitydragon' : 'opgg') : null }, sourceOnly: !allItems.has(item.apiName), recipeVerified: components.length === 2 && currentRecipes.length > 0 && opgg?.composition?.join('|') === components.join('|') };
  });
  const componentIds = new Set(items.filter(item => item.kind === 'component').map(item => item.id));
  for (const item of items) item.recipeVerified = item.recipeVerified && item.components.every(id => componentIds.has(id));
  const opggRows = opggAugments?.body?.rows;
  const opggHeaders = opggAugments?.body?.headers;
  const augmentTable = Array.isArray(opggRows) && Array.isArray(opggHeaders) ? opggRows.map(row => Object.fromEntries(opggHeaders.map((key, index) => [key, row[index]]))) : [];
  const currentAugmentTable = augmentTable.filter(augment => setAugmentIds.has(augment.apiName));
  const augmentCandidates = currentAugmentTable.length ? currentAugmentTable : set.augments.map(id => allItems.get(id)).filter(Boolean);
  const augments = augmentCandidates.map(candidate => {
    const item = allItems.get(candidate.apiName) ?? candidate;
    const description = cleanText(candidate.desc || item.desc, item.effects);
    return { id: item.apiName, name: cleanText(candidate.name || item.name).text, description: description.text || '来源未提供说明。', descriptionIncomplete: description.incomplete, tier: candidate.tier ?? null, icon: assetURL(item.icon, version) || candidate.imageUrl || null, source: candidate.tier ? 'opgg+communitydragon' : 'communitydragon' };
  });
  const sources = [{ id: 'communitydragon', url: `https://raw.communitydragon.org/${version}/cdragon/tft/zh_cn.json`, assetVersion: version, fetchedAt: manifest.fetchedAt, sourceTime: manifest.files?.zh_cn?.lastModified ?? null, sha256: manifest.files?.zh_cn?.sha256 ?? null, language: 'zh_cn', set: set.number },
    ...(validRecipeSource ? [{ id: 'opgg-recipes', url: opggRecipes.endpoint, tool: 'tft_list_item_combinations', sourcePatch: recipeBody.version ?? null, set: recipeBody.set, fetchedAt: opggRecipes.fetchedAt, sourceTime: null }] : [])];
  return { context: { game: 'tft', set: set.number, mutator: set.mutator, assetVersion: version, gamePatch: null, rulesVersion: `set${set.number}-assets${version}-recipes${validRecipeSource ? recipeBody.version : 'unverified'}-v4`, language: 'zh_cn', fetchedAt: manifest.fetchedAt }, champions, items, traits, augments,
    coverage: { champions: champions.length, rawSetChampions: set.champions.length, excludedNonShopEntities: set.champions.length - champions.length, championRolesKnown: champions.filter(champion => champion.role).length, championAbilitiesComplete: champions.filter(champion => !champion.ability.descriptionIncomplete).length,
      items: items.length, components: items.filter(item => item.kind === 'component').length, completedItems: items.filter(item => item.kind === 'completed').length, verifiedRecipes: items.filter(item => item.recipeVerified).length,
      artifacts: items.filter(item => item.category === 'artifact').length, sourceOnlyItems: items.filter(item => item.sourceOnly).length,
      allocationVerifiedItems: items.filter(item => item.allocationVerified).length, unverifiedSpecialItems: items.filter(item => item.kind === 'special' && !item.allocationVerified).length, traits: traits.length, augments: augments.length,
      upstreamAugmentRows: augmentTable.length, excludedAugmentRows: augmentTable.length - currentAugmentTable.length, excludedRecipeRows: validRecipeSource ? recipeBody.data.length - currentRecipes.length : null,
      statistics: 'OP.GG verified snapshots; patch/rank/region/star filters are unknown and unsupported', complete: false,
      limitations: ['百科仅展示当前标准模式已映射实体；源文件还含历史、测试与内部实体。', '大部分本赛季英雄技能数值与职责未导出，未知数值已明确标记。', '部分装备中文描述缺失，保留来源英文说明。', 'OP.GG 的装备与强化表混有旧赛季行，已通过当前模式实体交集排除。', '版本化资产不等于统计补丁；gamePatch 未核验。', '特殊装备兼容关系未核验；库存保留，不自动分配。锁装按用户现状保留，不验证其兼容关系。'] }, sources };
}
