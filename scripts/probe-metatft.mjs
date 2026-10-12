// Read-only probe of endpoints observed in MetaTFT's public Explorer bundle.
// No credentials, database writes, background jobs or model calls.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const API = 'https://api-hc.metatft.com';
const DEFAULT_RANKS = 'CHALLENGER,DIAMOND,EMERALD,GRANDMASTER,MASTER,PLATINUM';
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export function placementStats(placements) {
  if (!Array.isArray(placements) || placements.length !== 8 || placements.some(n => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error('Unexpected placement_count schema; do not treat this as zero samples.');
  }
  const sampleCount = placements.reduce((a, b) => a + b, 0);
  return {
    sampleCount,
    avgPlacement: sampleCount ? placements.reduce((sum, n, i) => sum + n * (i + 1), 0) / sampleCount : null,
    top4Rate: sampleCount ? placements.slice(0, 4).reduce((a, b) => a + b, 0) / sampleCount : null,
    winRate: sampleCount ? placements[0] / sampleCount : null,
  };
}

function identifier(value) {
  if (!IDENTIFIER.test(value ?? '')) throw new Error(`Invalid entity ID: ${value}`);
  return value;
}

export function buildExplorerUrl(options, patch) {
  if (!/^\d+\.\d+$/.test(patch.patch) || !/^[a-z]*$/.test(patch.b_patch_version ?? '')) throw new Error('Unexpected source patch metadata.');
  const days = Number(options.days ?? 3);
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error('Probe days must be between 1 and 7.');
  const ranks = (options.rank ?? DEFAULT_RANKS).split(',').sort();
  const knownRanks = new Set([...DEFAULT_RANKS.split(','), 'GOLD', 'SILVER', 'BRONZE', 'IRON']);
  if (!ranks.length || ranks.some(rank => !knownRanks.has(rank))) throw new Error('Invalid rank filter.');
  const query = new URLSearchParams({
    formatnoarray: 'true', compact: 'true', queue: '1100', patch: patch.patch,
    // Match the public website's request so the API reports filter_adjustment.
    // The probe rejects a response if the source actually broadens the scope.
    b_patch: patch.b_patch_version ?? '', days: String(days), rank: ranks.join(','), permit_filter_adjustment: 'true',
  });
  const champions = options.champion ?? [];
  for (const id of new Set(champions)) query.append('unit_unique', `${identifier(id)}-1`);
  for (const id of new Set(options['exclude-champion'] ?? [])) query.append('unit_unique', `!${identifier(id)}-1`);
  const occurrences = new Map();
  for (const value of options.item ?? []) {
    const parts = value.split('@');
    if (parts.length > 2) throw new Error('Use --item ITEM_ID or --item ITEM_ID@CHAMPION_ID.');
    const [item, holder] = parts;
    identifier(item);
    if (holder !== undefined) identifier(holder);
    const key = `${holder ?? ''}:${item}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    query.append(holder ? 'unit_item_unique' : 'item_unique', holder ? `${holder}-1&${item}-${occurrence}` : `${item}-${occurrence}`);
  }
  const group = options.group ?? 'total';
  let path = { total: 'total', units: 'units_unique', items: 'items_unique', traits: 'traits', comps: 'exact_units_traits2' }[group];
  if (group === 'holders') path = `item_units_unique/${identifier(options['group-item'])}-1`;
  if (group === 'builds') path = options['group-holder']
    ? `unit_builds/${identifier(options['group-holder'])}`
    : `unit_builds/any_unit/${identifier(options['group-item'])}`;
  if (!path) throw new Error('Unknown group; use total, units, items, traits, holders, builds or comps.');
  if (!champions.length && !(options.item ?? []).length && !(options['exclude-champion'] ?? []).length) throw new Error('Supply at least one entity condition.');
  return `${API}/tft-explorer-api/${path}?${query}`;
}

async function fetchPublicJson(url, file) {
  const startedAt = new Date().toISOString();
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  const body = await response.text();
  await writeFile(file, body);
  const record = {
    url, method: 'GET', startedAt, receivedAt: new Date().toISOString(), status: response.status,
    bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'),
    contentType: response.headers.get('content-type'), rawFile: file,
  };
  if (!response.ok) return { record, error: `HTTP ${response.status}; no retry or access workaround attempted.` };
  try { return { record, data: JSON.parse(body) }; }
  catch { return { record, error: 'Response is not JSON.' }; }
}

async function main() {
  const { values } = parseArgs({ options: {
    champion: { type: 'string', multiple: true }, item: { type: 'string', multiple: true },
    'exclude-champion': { type: 'string', multiple: true }, group: { type: 'string' },
    'group-item': { type: 'string' }, 'group-holder': { type: 'string' },
    days: { type: 'string' }, rank: { type: 'string' }, 'out-dir': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node scripts/probe-metatft.mjs --item ITEM_ID[@CHAMPION_ID] [--champion CHAMPION_ID] [--group total|units|items|traits|holders|builds|comps] [--group-item ITEM_ID | --group-holder CHAMPION_ID] [--days 3] [--out-dir tmp/path]\nRepeat --item or --champion to test simultaneous conditions. --exclude-champion tests exclusion. Uses public GET requests; does not publish or import data.');
    return;
  }
  const dir = resolve(values['out-dir'] ?? `tmp/metatft-probe-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const report = { provider: 'MetaTFT', officialIntegrationContractVerified: false, databaseWritten: false, modelCalled: false, options: values, requests: [] };
  try {
    const metadata = await fetchPublicJson(`${API}/tft-stat-api/patch`, resolve(dir, 'patch.json'));
    report.requests.push(metadata.record);
    if (metadata.error) throw new Error(metadata.error);
    const url = buildExplorerUrl(values, metadata.data);
    const result = await fetchPublicJson(url, resolve(dir, 'result.json'));
    report.requests.push(result.record);
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.data.data)) throw new Error('Unexpected statistics schema.');
    const rows = result.data.data.map(row => ({ ...row, metrics: placementStats(row.placement_count) }));
    report.patchEvidence = { metadataDeclaredCurrentPatch: metadata.data, requestedPatch: metadata.data.patch, requestedBpatch: metadata.data.b_patch_version, statisticsResponsePatch: result.data.patch ?? null };
    report.filterAdjustment = result.data.filter_adjustment ?? null;
    if (report.filterAdjustment?.override_applied !== false) throw new Error('Effective filter scope was adjusted or not confirmed by the source.');
    report.status = rows.some(row => row.metrics.sampleCount > 0) ? 'live' : 'empty';
    report.rowCount = rows.length;
    report.sampleUnit = 'placement observations; distinct match count is not provided';
    report.metricsDerivation = 'sampleCount=sum(placement_count); average=sum(count[i]*(i+1))/sampleCount; top4=sum(first 4)/sampleCount; win=count[0]/sampleCount';
    report.exampleRows = rows.slice(0, 3);
    report.exhaustive = false;
  } catch (error) {
    report.status = 'error'; report.error = error.message; process.exitCode = 1;
  }
  const file = resolve(dir, 'report.json');
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ reportFile: file, ...report }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
