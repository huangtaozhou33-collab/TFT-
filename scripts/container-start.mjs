import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let child = null, stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; child?.kill(signal); });

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [script, ...args], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error(`Unable to start ${script}.`)));
    child.once('exit', (code, signal) => { child = null; resolve({ code: code ?? (signal ? 1 : 0), signal }); });
  });
}

try {
  if (process.env.STORAGE_BACKEND === 'mysql') {
    console.log('Checking schema and importing the bundled season release...');
    const bootstrap = await run('scripts/bootstrap-db.mjs');
    if (bootstrap.code !== 0 || stopping) {
      process.exitCode = bootstrap.code || 1;
      console.error('Database initialization did not finish. The HTTP service has not started.');
    }
    if (!process.exitCode && !stopping) {
      const attribution = await run('scripts/assign-statistics-patch.mjs', ['--apply']);
      if (attribution.code !== 0) console.error('Reviewed patch attribution could not be applied; existing publication is retained.');
    }
  }
  if (!process.exitCode && !stopping) {
    const result = await run('server/index.mjs');
    process.exitCode = stopping ? 0 : result.code;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
