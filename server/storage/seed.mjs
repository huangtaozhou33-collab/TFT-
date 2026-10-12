import { getCatalog, fetchOPGGTool } from '../data.mjs';
import { getLibrarySnapshot } from '../library-data.mjs';
import { getSeasonMechanic } from '../mechanics-data.mjs';
import { getExplorerOverallStats } from '../explorer-overall.mjs';
import { getTraitStats } from '../trait-data.mjs';
import { readManifest, queryKey, sha256 } from '../../scripts/stats-cache.mjs';
import { buildKnowledgeBundle } from '../knowledge/bundle.mjs';
import { getGlossary } from '../knowledge/glossary.mjs';
import { knowledgeInScope } from '../knowledge/scope.mjs';

export const SEED_VERSION = 'v1';
export const CHUNKER_VERSION = 'conditional-groups-v1';
const knownPatch = value => typeof value === 'string' && /^\d+\.\d+[a-z]?$/.test(value);
const compareKeys = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

// Ages are recomputed at read time. Captured source timestamps remain unchanged.
function capturedDTO(value) {
  const copy = structuredClone(value);
  if (copy.evidence) delete copy.evidence.snapshotAgeSeconds;
  return copy;
}

function snapshot(key, kind, payload, sourcePatch = null) {
  return { key, kind, sourcePatch: knownPatch(sourcePatch) ? sourcePatch : null, payload: capturedDTO(payload) };
}

export function buildSeedBundle({ catalog, library, mechanics, overall, traits, opgg = [], statsManifest = null, glossary = getGlossary() }) {
  if (!catalog?.context || !Number.isInteger(catalog.context.set) || catalog.context.game !== 'tft') throw new Error('Seed requires a valid TFT catalog context.');
  if (library?.status !== 'ready' || !library.documents?.length) throw new Error('Seed requires a validated published knowledge library.');
  if (!mechanics?.entries?.length || mechanics.context?.set !== catalog.context.set) throw new Error('Seed requires validated season mechanics.');
  if (overall?.status !== 'live' || !knownPatch(overall.evidence?.sourcePatch)) throw new Error('Seed requires patch-verified overall statistics.');
  for (const [name, pack] of Object.entries({ library, mechanics, overall, traits })) {
    if (pack?.context?.set !== catalog.context.set) throw new Error(`Seed ${name} belongs to another season.`);
  }
  const knowledge = buildKnowledgeBundle({ catalog, library, mechanics, glossary });
  const libraryPatches = knowledge.documents.filter(doc => doc.kind === 'library' && doc.eligible).map(doc => doc.sourcePatch);
  if (!libraryPatches.length) throw new Error('Seed has no reviewed patch-qualified library documents.');
  const patches = new Set([...libraryPatches, overall.evidence.sourcePatch]);
  if (patches.size !== 1) throw new Error('Reviewed knowledge and overall statistics refer to conflicting patches.');
  const sourcePatch = [...patches][0];
  if (catalog.context.gamePatch && catalog.context.gamePatch !== sourcePatch) throw new Error('Catalog game patch conflicts with the seed evidence patch.');
  const snapshots = [
    snapshot('catalog', 'entity_reference', catalog, catalog.context.gamePatch),
    snapshot('library', 'knowledge', library, sourcePatch),
    snapshot('glossary', 'editorial_knowledge', glossary),
    // This source combines patch-unknown effects with independently proven conditions.
    snapshot('mechanics', 'entity_reference', mechanics, mechanics.source?.sourcePatch),
    snapshot('overall', 'statistics', overall, overall.evidence.sourcePatch),
    snapshot('traits', 'statistics', traits, traits.evidence?.sourcePatch),
    ...opgg.map(({ tool, args, result }) => {
      if (!result || result.status === 'not_cached') throw new Error(`Seed source record is missing or failed validation: ${tool}.`);
      const kind = ['tft_list_item_combinations', 'tft_list_augments'].includes(tool) ? 'entity_reference' : 'statistics';
      return snapshot(`opgg:${queryKey(tool, args)}`, kind, result, result.evidence?.sourcePatch);
    })
  ].sort(compareKeys);
  if (new Set(snapshots.map(row => row.key)).size !== snapshots.length) throw new Error('Seed contains duplicate source snapshot keys.');
  const capabilities = [
    { id: 'opgg_mcp', source: 'OP.GG MCP', transport: 'scheduled_snapshot', jointMatchQueries: false, matchLevelObservations: false,
      championBuilds: true, itemHolders: true, namedCompAggregates: true, rankFilters: false, regionFilters: false, starFilters: false, historicalPatchQueries: false,
      statisticsPatchVerified: opgg.filter(row => !['tft_list_item_combinations', 'tft_list_augments'].includes(row.tool)).every(row => knownPatch(row.result.evidence?.sourcePatch)) && opgg.length > 0,
      endpoints: [
        { tool: 'tft_get_champion_item_build', parameters: ['champion_id'], sampleDenominator: 'itemCount: champion occurrences with an observed item tuple' },
        { tool: 'tft_list_champions_for_item', parameters: ['item_id'], sampleDenominator: 'totalCount: champion occurrences holding the requested item' },
        { tool: 'tft_list_meta_decks', parameters: [], sampleDenominator: 'stat.deck.compsCount: source comp aggregate games; source plans are not raw matches' }
      ], note: 'Unknown source patches remain isolated; source comp membership is not a joint match population.' },
    { id: 'tactics_tools_overall', source: 'Tactics.tools', sourcePatch: overall.evidence.sourcePatch, population: overall.evidence.population ?? null,
      championOverallStats: true, itemOverallStats: true, jointMatchQueries: false, matchLevelObservations: false,
      rankFilters: false, regionFilters: false, starFilters: false, sourceCapabilities: overall.capabilities ?? {},
      sampleDenominator: overall.evidence.sampleDenominator ?? null },
    { id: 'tactics_tools_traits', source: 'Tactics.tools', sourcePatch: traits.evidence?.sourcePatch ?? null, population: traits.evidence?.population ?? null,
      traitTierStats: traits.status === 'live', jointMatchQueries: false, matchLevelObservations: false, sampleDenominator: traits.evidence?.sampleDenominator ?? null },
    { id: 'little_buddy_rules', source: 'Little Buddy Bot', sourcePatch, structuredKnowledge: true, offeringConditions: true,
      conditionalRewards: true, outcomeStatistics: false, wispProbabilityWeights: false }
  ];
  const statistics = snapshots.filter(row => row.kind === 'statistics');
  const manifest = {
    seedVersion: SEED_VERSION, chunkerVersion: CHUNKER_VERSION, season: catalog.context.set, sourcePatch,
    patchMeaning: 'Version of the verified seed evidence; not a claim about the latest live game patch.',
    currentPatchMustBeCheckedSeparately: true, jointMatchQueries: false, rawMatchObservations: 0,
    catalogContext: catalog.context,
    fingerprints: snapshots.map(row => ({ key: row.key, contentHash: sha256(row.payload), sourcePatch: row.sourcePatch,
      fetchedAt: row.payload.evidence?.fetchedAt ?? row.payload.source?.fetchedAt ?? row.payload.context?.fetchedAt ?? null,
      sourceTime: row.payload.evidence?.sourceTime ?? row.payload.source?.sourceTime ?? null,
      publishedAt: row.payload.publishedAt ?? null })),
    statsCapture: statsManifest ? { cacheKey: statsManifest.cacheKey, captureId: statsManifest.captureId, publishedAt: statsManifest.publishedAt, coverage: statsManifest.coverage } : null,
    counts: {
      entities: knowledge.entities.length, documents: knowledge.documents.length, chunks: knowledge.chunks.length,
      eligibleDocuments: knowledge.documents.filter(row => knowledgeInScope(row, sourcePatch)).length,
      eligibleChunks: knowledge.chunks.filter(row => knowledgeInScope(row, sourcePatch)).length,
      glossaryDocuments: knowledge.documents.filter(row => row.kind === 'glossary').length,
      glossaryChunks: knowledge.chunks.filter(row => row.kind === 'glossary').length,
      snapshots: snapshots.length, statisticsSnapshots: statistics.length,
      patchVerifiedStatisticsSnapshots: statistics.filter(row => row.sourcePatch === sourcePatch).length,
      quarantinedStatisticsSnapshots: statistics.filter(row => row.sourcePatch !== sourcePatch).length,
      opggSnapshots: opgg.length, sourceCapabilities: capabilities.length,
      libraryDocuments: library.documents.length,
      tables: library.documents.reduce((sum, doc) => sum + doc.tables.length, 0),
      tableRows: library.documents.reduce((sum, doc) => sum + doc.tables.reduce((rows, table) => rows + table.rows.length, 0), 0)
    }
  };
  const bundle = { season: catalog.context.set, sourcePatch, manifest, ...knowledge, snapshots, capabilities };
  return { id: sha256(bundle), ...bundle };
}

/** Bootstrap reads only checksum-validated local releases, even in MySQL mode. */
export async function collectSeedBundle(dependencies = {}) {
  const withLocalSnapshots = dependencies.withLocalSnapshots ?? (await import('./runtime.mjs')).withLocalSnapshots;
  const readers = { getCatalog, getLibrarySnapshot, getSeasonMechanic, getExplorerOverallStats, getTraitStats, readManifest, fetchOPGGTool, ...dependencies };
  return withLocalSnapshots(async () => {
    const catalog = await readers.getCatalog();
    const [library, mechanics, overall, traits, statsManifest] = await Promise.all([
      readers.getLibrarySnapshot({ catalog }), readers.getSeasonMechanic({ catalog }), readers.getExplorerOverallStats({ catalog }),
      readers.getTraitStats({ catalog }), readers.readManifest(catalog)
    ]);
    if (!statsManifest?.records) throw new Error('Seed requires a validated statistics manifest.');
    const entries = Object.values(statsManifest.records).sort((a, b) => queryKey(a.tool, a.args).localeCompare(queryKey(b.tool, b.args)));
    const opgg = [];
    for (let index = 0; index < entries.length; index += 8) {
      opgg.push(...await Promise.all(entries.slice(index, index + 8).map(async entry => ({
        tool: entry.tool, args: entry.args, result: await readers.fetchOPGGTool(entry.tool, entry.args)
      }))));
    }
    return buildSeedBundle({ catalog, library, mechanics, overall, traits, statsManifest, opgg });
  });
}

export function seedSummary(bundle) {
  return { releaseId: bundle.id, seedVersion: bundle.manifest.seedVersion, chunkerVersion: bundle.manifest.chunkerVersion,
    season: bundle.season, sourcePatch: bundle.sourcePatch, patchMeaning: bundle.manifest.patchMeaning,
    counts: bundle.manifest.counts, jointMatchQueries: false };
}
