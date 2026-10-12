// Restore only absent legacy test records. No network, keys or database access.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { sha256 } from './stats-cache.mjs';
const {captures}=JSON.parse(gunzipSync(await readFile(new URL('../tests/fixtures/legacy-statistics.json.gz',import.meta.url))));
const root=new URL('../data/stats/',import.meta.url);
let restored=0;
for(const {manifest,records} of captures){
 if(!/^tft-set\d+-assets[\d.]+-[a-f0-9]+$/.test(manifest.cacheKey)||! /^[a-f0-9-]{36}$/.test(manifest.captureId))throw new Error('Invalid fixture path.');
 const capture=new URL(`${manifest.cacheKey}/snapshots/${manifest.captureId}/`,root);
 await mkdir(capture,{recursive:true});
 try{await writeFile(new URL('manifest.json',capture),JSON.stringify(manifest),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
for(const entry of Object.values(manifest.records)){
 if(!/^[a-f0-9]{64}\.json$/.test(entry.file)||sha256(records[entry.file])!==entry.sha256)throw new Error('Test fixture integrity mismatch.');
 const directory=new URL(`${manifest.cacheKey}/snapshots/${manifest.captureId}/records/`,root);
 await mkdir(directory,{recursive:true});
 try{await writeFile(new URL(entry.file,directory),JSON.stringify(records[entry.file]),{flag:'wx'});restored++;}
 catch(error){if(error.code!=='EEXIST')throw error;}
}
}
console.log(`Prepared ${restored} missing legacy test records; existing files unchanged.`);
