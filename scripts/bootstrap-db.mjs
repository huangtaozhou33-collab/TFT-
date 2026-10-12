import { pathToFileURL } from 'node:url';
import { collectSeedBundle, seedSummary } from '../server/storage/seed.mjs';
import { migrate, publishBundle, closeDatabase } from '../server/storage/repository.mjs';
import { loadPackedSeed } from './export-seed.mjs';

export async function bootstrapDatabase({ dryRun = false, fromLocal = false, dependencies = {} } = {}) {
  const collect = dependencies.collectSeedBundle ?? collectSeedBundle;
  const load = dependencies.loadPackedSeed ?? loadPackedSeed;
  // Existing collector injection remains isolated from the checked-in production package.
  const useCollector = fromLocal || (dependencies.collectSeedBundle && !dependencies.loadPackedSeed);
  const bundle = useCollector ? await collect() : (await load() ?? await collect());
  if (dryRun) return { status: 'dry_run', ...seedSummary(bundle) };
  try {
    await (dependencies.migrate ?? migrate)();
    const publication = await (dependencies.publishBundle ?? publishBundle)(bundle);
    return { ...seedSummary(bundle), ...publication };
  } finally { await (dependencies.closeDatabase ?? closeDatabase)(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run', '--from-local'].includes(arg))) {
    console.error('Usage: node scripts/bootstrap-db.mjs [--dry-run] [--from-local]'); process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await bootstrapDatabase({ dryRun: args.includes('--dry-run'), fromLocal: args.includes('--from-local') }), null, 2)); }
    catch (error) {
      // Driver error messages can include connection details; report only a bounded code.
      const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'SEED_BOOTSTRAP_FAILED';
      console.error(JSON.stringify({ status: 'error', code, message: 'Seed validation or database bootstrap failed. Check local source integrity and database readiness.' }));
      process.exitCode = 1;
    }
  }
}
