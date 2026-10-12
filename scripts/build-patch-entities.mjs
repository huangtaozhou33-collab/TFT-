import {readFile,writeFile}from 'node:fs/promises';
import {buildPatchIndex}from '../server/patch-entities.mjs';
const read=async p=>JSON.parse(await readFile(new URL('../'+p,import.meta.url),'utf8'));
const catalog=await read('data/catalog.json');
const raw=Object.fromEntries(await Promise.all(['en_us','zh_cn','zh_tw'].map(async locale=>[locale,await read('data/raw/cdragon-'+locale+'.json')])));
const index=buildPatchIndex(catalog,raw);await writeFile(new URL('../data/patch-entities.json',import.meta.url),JSON.stringify(index));console.log('Patch entity index:',index.entities.length);
