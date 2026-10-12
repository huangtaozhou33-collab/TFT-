import { readFile } from 'node:fs/promises';
import { getPool, getActiveRelease, closeDatabase } from '../server/storage/repository.mjs';
import { applyPatchAssignments } from '../server/storage/patch-attribution.mjs';
import { loadPackedSeed } from './export-seed.mjs';

try {
  const policy = JSON.parse(await readFile(new URL('../data/patch-attributions/opgg-18.4.json', import.meta.url), 'utf8'));
  const db = await getPool(), release = await getActiveRelease(db);
  if (!release) throw new Error('No published release.');
  const seed=await loadPackedSeed();
  const referenceSnapshots=seed?.id===release.id?new Map(seed.snapshots.map(row=>[row.key,row.payload])):new Map();
  console.log(JSON.stringify(await applyPatchAssignments(db, release, policy, { apply: process.argv.includes('--apply'),referenceSnapshots }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code || 'PATCH_ATTRIBUTION_FAILED' })); process.exitCode = 1;
} finally { await closeDatabase(); }
