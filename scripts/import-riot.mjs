import { readFile,readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate,closeDatabase,getPool } from '../server/storage/repository.mjs';
import { importRiotMatch,getRiotStatus } from '../server/riot/repository.mjs';
import { getCatalog } from '../server/data.mjs';
import { loadRiotPatchWindows } from '../server/riot/patch-policy.mjs';

export async function importDirectory(directory) {
  await migrate();
  const db=await getPool(),catalog=await getCatalog(),patchWindows=await loadRiotPatchWindows(db);
  const report={imported:0,duplicate:0,reclassified:0,conflict:0,ready:0,quarantined:0};
  for (const file of (await readdir(directory)).filter(f=>f.endsWith('.json')).sort()) {
    const record=JSON.parse(await readFile(resolve(directory,file),'utf8'));
    const result=await importRiotMatch(record,{db,catalog,patchWindows});
    report[result.status]=(report[result.status]||0)+1;
    if(result.readiness)report[result.readiness]=(report[result.readiness]||0)+1;
  }
  return {...report,storage:await getRiotStatus(db)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if(process.argv.length!==3)throw Object.assign(new Error(),{code:'RIOT_IMPORT_DIRECTORY_REQUIRED'});
    console.log(JSON.stringify(await importDirectory(resolve(process.argv[2])),null,2));
  } catch(error) {console.error(JSON.stringify({status:'failed',code:/^[A-Z0-9_]{1,80}$/.test(error.code||'')?error.code:'RIOT_IMPORT_FAILED'}));process.exitCode=1;}
  finally {await closeDatabase();}
}
