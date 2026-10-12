import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { collectSeedBundle, seedSummary, SEED_VERSION, CHUNKER_VERSION } from '../server/storage/seed.mjs';
import { sha256, stableJSON } from './stats-cache.mjs';
import { knowledgeInScope } from '../server/knowledge/scope.mjs';

export const DEFAULT_SEED_DIR = new URL('../data/seed/', import.meta.url);
const PACKAGE_SCHEMA = 1;
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const byteHash = bytes => createHash('sha256').update(bytes).digest('hex');
const directoryURL = directory => directory instanceof URL ? directory : pathToFileURL(resolve(directory) + sep);
function invalid(message) { return Object.assign(new Error(message), { code: 'SEED_PACKAGE_INVALID' }); }
async function maybeRead(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function verifyBundle(bundle) {
  if (!bundle || !/^[a-f0-9]{64}$/.test(bundle.id ?? '')) throw invalid('Seed bundle ID is missing.');
  const { id, ...content } = bundle;
  if (sha256(content) !== id) throw invalid('Seed bundle content hash differs from its ID.');
  if (bundle.manifest?.seedVersion !== SEED_VERSION || bundle.manifest?.chunkerVersion !== CHUNKER_VERSION ||
      !Number.isInteger(bundle.season) || bundle.season < 1 || !/^\d+\.\d+[a-z]?$/.test(bundle.sourcePatch ?? '') ||
      bundle.manifest.season !== bundle.season || bundle.manifest.sourcePatch !== bundle.sourcePatch) throw invalid('Seed version metadata is invalid.');
  for (const key of ['entities', 'documents', 'chunks', 'snapshots', 'capabilities']) if (!Array.isArray(bundle[key])) throw invalid(`Seed ${key} must be an array.`);
  const expected = { entities: bundle.entities.length, documents: bundle.documents.length, chunks: bundle.chunks.length,
    snapshots: bundle.snapshots.length, sourceCapabilities: bundle.capabilities.length,
    eligibleDocuments: bundle.documents.filter(row => knowledgeInScope(row, bundle.sourcePatch)).length,
    eligibleChunks: bundle.chunks.filter(row => knowledgeInScope(row, bundle.sourcePatch)).length,
    statisticsSnapshots: bundle.snapshots.filter(row => row.kind === 'statistics').length,
    patchVerifiedStatisticsSnapshots: bundle.snapshots.filter(row => row.kind === 'statistics' && row.sourcePatch === bundle.sourcePatch).length,
    quarantinedStatisticsSnapshots: bundle.snapshots.filter(row => row.kind === 'statistics' && row.sourcePatch !== bundle.sourcePatch).length,
    opggSnapshots: bundle.snapshots.filter(row => row.key.startsWith('opgg:')).length };
  if (Object.entries(expected).some(([key, value]) => bundle.manifest.counts?.[key] !== value)) throw invalid('Seed counts differ from the bundled records.');
  if (!Array.isArray(bundle.manifest.fingerprints) || bundle.manifest.fingerprints.length !== bundle.snapshots.length) throw invalid('Seed source fingerprints are incomplete.');
  const fingerprints = new Map(bundle.manifest.fingerprints.map(row => [row.key, row]));
  if (fingerprints.size !== bundle.snapshots.length || bundle.snapshots.some(row => fingerprints.get(row.key)?.contentHash !== sha256(row.payload) || fingerprints.get(row.key)?.sourcePatch !== row.sourcePatch)) throw invalid('Seed source fingerprint does not match its snapshot.');
  return bundle;
}

/** Missing packages may fall back to local readers; damaged or partial packages cannot. */
export async function loadPackedSeed({ directory = DEFAULT_SEED_DIR } = {}) {
  const base = directoryURL(directory), manifestPath = new URL('manifest.json', base), packagePath = new URL('current.json.gz', base);
  const manifestBytes = await maybeRead(manifestPath);
  if (!manifestBytes) {
    if (await maybeRead(packagePath)) throw invalid('A seed archive exists without its manifest.');
    return null;
  }
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw invalid('Seed manifest is not valid JSON.'); }
  if (manifest.schemaVersion !== PACKAGE_SCHEMA || manifest.file !== 'current.json.gz' || manifest.compression !== 'gzip' ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(manifest.uncompressedSha256 ?? '')) throw invalid('Unsupported seed package metadata.');
  let details;
  try { details = await stat(packagePath); } catch (error) { if (error.code === 'ENOENT') throw invalid('Seed archive is missing.'); throw error; }
  if (details.size > MAX_COMPRESSED_BYTES || details.size !== manifest.compressedBytes) throw invalid('Seed archive size is invalid.');
  const compressed = await readFile(packagePath);
  if (byteHash(compressed) !== manifest.sha256) throw invalid('Seed compressed bytes failed checksum verification.');
  let bytes, bundle;
  try { bytes = gunzipSync(compressed, { maxOutputLength: MAX_JSON_BYTES }); } catch { throw invalid('Seed archive cannot be decompressed.'); }
  if (bytes.length !== manifest.uncompressedBytes || byteHash(bytes) !== manifest.uncompressedSha256) throw invalid('Seed uncompressed bytes failed checksum verification.');
  try { bundle = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('Seed bundle is not valid JSON.'); }
  verifyBundle(bundle);
  const expectedMetadata = { bundleId: bundle.id, season: bundle.season, sourcePatch: bundle.sourcePatch,
    seedVersion: bundle.manifest.seedVersion, chunkerVersion: bundle.manifest.chunkerVersion, counts: bundle.manifest.counts };
  if (Object.entries(expectedMetadata).some(([key, value]) => stableJSON(manifest[key]) !== stableJSON(value))) throw invalid('Seed manifest metadata differs from the bundled content.');
  return bundle;
}

export async function exportPackedSeed({ directory = DEFAULT_SEED_DIR, bundle = null, collect = collectSeedBundle } = {}) {
  bundle = verifyBundle(bundle ?? await collect());
  const base = directoryURL(directory), json = Buffer.from(stableJSON(bundle), 'utf8');
  const compressed = gzipSync(json, { level: 9 });
  if (compressed.length > MAX_COMPRESSED_BYTES || json.length > MAX_JSON_BYTES) throw invalid('Seed exceeds package size limits.');
  const manifest = { schemaVersion: PACKAGE_SCHEMA, file: 'current.json.gz', compression: 'gzip',
    sha256: byteHash(compressed), uncompressedSha256: byteHash(json),
    bundleId: bundle.id, season: bundle.season, sourcePatch: bundle.sourcePatch,
    seedVersion: bundle.manifest.seedVersion, chunkerVersion: bundle.manifest.chunkerVersion,
    compressedBytes: compressed.length, uncompressedBytes: json.length, counts: bundle.manifest.counts };
  const manifestText = `${stableJSON(manifest)}\n`;
  await mkdir(base, { recursive: true });
  const oldManifest = await maybeRead(new URL('manifest.json', base));
  const oldPackage = await maybeRead(new URL('current.json.gz', base));
  if (oldManifest?.toString('utf8') === manifestText && oldPackage?.equals(compressed)) return { status: 'unchanged', manifest, summary: seedSummary(bundle) };
  const suffix = `${process.pid}-${randomUUID()}`;
  const nextPackage = new URL(`current.json.gz.${suffix}.next`, base), nextManifest = new URL(`manifest.json.${suffix}.next`, base);
  try {
    await writeFile(nextPackage, compressed); await writeFile(nextManifest, manifestText, 'utf8');
    await rename(nextPackage, new URL('current.json.gz', base));
    await rename(nextManifest, new URL('manifest.json', base));
  } finally { await Promise.all([nextPackage, nextManifest].map(path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }))); }
  return { status: 'exported', manifest, summary: seedSummary(bundle) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) { console.error('Usage: node scripts/export-seed.mjs'); process.exitCode = 1; }
  else try {
    const result = await exportPackedSeed();
    console.log(JSON.stringify({ status: result.status, ...result.summary, compressedBytes: result.manifest.compressedBytes,
      uncompressedBytes: result.manifest.uncompressedBytes, sha256: result.manifest.sha256 }, null, 2));
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'SEED_EXPORT_FAILED';
    console.error(JSON.stringify({ status: 'error', code, message: 'Validated seed export failed; check local source integrity.' })); process.exitCode = 1;
  }
}
