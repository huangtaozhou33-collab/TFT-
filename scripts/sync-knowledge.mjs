import { syncStats } from './sync-stats.mjs';
import { syncTraits } from './sync-traits.mjs';
import { syncMechanics } from './sync-mechanics.mjs';
import { syncMechanicsConditions } from './sync-mechanics-conditions.mjs';
import { syncExplorer } from './sync-explorer.mjs';
import { syncTeamCodes } from './sync-team-codes.mjs';
import { syncLibrary } from './sync-library.mjs';

// Each source retains its own patch, population and atomic publication.
// Same-version defaults skip each published source independently.
try {
  const args = process.argv.slice(2);
  await syncStats(args);
  await syncTraits(args);
  await syncExplorer(args);
  await syncMechanics(args);
  await syncMechanicsConditions(args);
  await syncTeamCodes(args);
  await syncLibrary(args);
} catch (error) {
  console.error(JSON.stringify({ status: 'knowledge_sync_incomplete', reason: error.message, note: '已发布的数据包保留；可以重新运行补录命令。' }));
  process.exitCode = 1;
}
