import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {docs} from './library-facts.mjs';
import {normalizeAugmentRules,buildBonusGiftDocument} from './library-rules.mjs';
import {CATALOG_TRANSLATIONS} from './library-descriptions.mjs';
import {cacheContext,cacheKeyFor,sha256} from './stats-cache.mjs';
import {getCatalog} from '../server/data.mjs';
import {getSeasonMechanic} from '../server/mechanics-data.mjs';
import {LIBRARY_DIR,libraryEntityFingerprint,readLibrarySnapshot,validateLibrary} from '../server/library-data.mjs';

const reviewedSources=new URL('./library-reviewed-sources.json',import.meta.url);
const canonical = value=>typeof value==='string'?value.replaceAll('战术师之冠','金铲铲冠冕').replaceAll('战术师斗篷','金锅铲冠冕').replaceAll('战术师之盾','金锅锅冠冕').replaceAll('小型英雄复制器','次级英雄复制器').replaceAll('光明幸运装备宝箱','光明版幸运装备宝箱').replaceAll('赌徒之刃（神器）','投机者之刃'):value;
export async function syncLibrary(args=[],{catalog,dir=LIBRARY_DIR,captureDir}={}) {
  catalog ??= await getCatalog();
  const previous=await readLibrarySnapshot(catalog,dir);
  if(previous&&!args.includes('--force')) {console.log(JSON.stringify({status:'skipped',source:'中文机制资料库',releaseId:previous.manifest.releaseId}));return previous;}
  if(catalog.context.set!==18) throw new Error('中文规则作者资料仅适用于S18，必须重新核验新赛季。');
  captureDir ??= pathToFileURL(resolve(args.find(arg=>arg.startsWith('--from='))?.slice(7) || 'tmp/v3-reference')+'/');
  const json=async filename=>JSON.parse(await readFile(new URL(filename,captureDir),'utf8'));
  const locks=JSON.parse(await readFile(reviewedSources,'utf8'));
  const readReviewedText=async (file,metadataFile,key)=>{
    const [text,source]=await Promise.all([readFile(new URL(file,captureDir),'utf8'),json(metadataFile)]);
    if(sha256(text)!==source.sha256||source.sha256!==locks[key]) throw new Error(`${file}来源已变化，需核对中文资料后更新审核锁。`);
    return {text,source};
  };
  const offerings=await readReviewedText('augment-rules.csv','augment-rules-source.json','augmentRules');
  const bonus=await readReviewedText('bonus-gift.csv','bonus-gift-source.json','bonusGift');
  const mechanics=await getSeasonMechanic();
  const authored=[...docs,buildBonusGiftDocument(bonus.text,catalog,mechanics.entries ?? [])];
  const documents=[];
  for(const authoredDoc of authored) {
    const capture=await json(`${authoredDoc.slug}.json`);
    if(capture.sha256!==locks.pages[authoredDoc.slug]) throw new Error(`页面变更需复核：${authoredDoc.slug}`);
    const imageNumbers=authoredDoc.sourceImages ?? [2];
    const images=imageNumbers.map(n=>capture.images[n-1]);
    if(images.some(image=>!image)) throw new Error(`来源图片不完整：${authoredDoc.id}`);
    for(const image of images) {
      const bytes=await readFile(new URL(image.file,captureDir));
      if(createHash('sha256').update(bytes).digest('hex')!==image.sha256||image.sha256!==locks.images[image.file]) throw new Error(`来源图变化需复核：${image.file}`);
    }
    const pagePatch=images.map(image=>image.title?.match(/Patch\s+(\d+\.\d+)/i)?.[1]).find(Boolean) ?? capture.headings.map(title=>title.match(/Patch\s+(\d+\.\d+)/i)?.[1]).find(Boolean) ?? null;
    const sourcePatch=Object.hasOwn(authoredDoc,'sourcePatch')?authoredDoc.sourcePatch:pagePatch;
    const retrievalEligible=authoredDoc.retrievalEligible!==false&&!authoredDoc.conflicts?.length&&sourcePatch==='18.4';
    const doc={...authoredDoc,set:18,sourcePatch,reviewStatus:authoredDoc.conflicts?.length?'conflict':retrievalEligible?'reviewed':'reference',retrievalEligible,
      entities:authoredDoc.entities.map(ref=>{if(ref.type!=='wisps')return ref;const entry=mechanics.entries.find(entry=>entry.id===ref.id);return {...ref,name:entry?.name ?? null,variant:entry?.upgrade?.variant ?? null};}),
      aliases:[...new Set([...authoredDoc.aliases,...authoredDoc.entities.flatMap(ref=>catalog[ref.type]?.filter(entity=>entity.id===ref.id).map(entity=>entity.name) ?? [])])],
      title:canonical(authoredDoc.title),rules:authoredDoc.rules.map(canonical),tables:authoredDoc.tables.map(table=>({...table,rows:table.rows.map(row=>({...row,cells:row.cells.map(canonical)}))})),
      source:{name:'Little Buddy Bot',url:capture.url,fetchedAt:capture.fetchedAt,sha256:capture.sha256,pagePatch,imageUpdatedAt:authoredDoc.imageUpdatedAt,
        assets:images.map(image=>({url:image.url,sha256:image.sha256,fetchedAt:image.fetchedAt,filePatchHint:image.url.match(/patch-(\d+\.\d+)/)?.[1] ?? null})),
        ...(authoredDoc.id==='bonus-gift'?{csv:bonus.source}:{}),note:'中文转录与图标核对；概率保留来源精度。页面补丁、图片文件名和图内更新日期分别记录。'}};
    if(!retrievalEligible&&!doc.conflicts?.length) doc.applicability='reference_only';
    documents.push(doc);
  }
  const normalized=normalizeAugmentRules(offerings.text,catalog);
  const payload={schemaVersion:1,cacheKey:cacheKeyFor(catalog),context:cacheContext(catalog),entityFingerprint:libraryEntityFingerprint(catalog),documents,
    augmentRules:normalized.rules,catalogTranslations:CATALOG_TRANSLATIONS,rulesSource:{...offerings.source,name:'Little Buddy Bot · 强化公开表',sourcePatch:'18.4'},offeringCoverage:normalized.coverage,
    editorial:{language:'zh_cn',referencePatch:'18.4',reviewedAt:'2026-10-08',excludedArchives:'汇总页中的旧赛季图表未并入当前数值；历史时间线未转录。'}};
  const validation=validateLibrary(payload,catalog);
  if(!validation.valid) throw new Error(`中文资料发布校验失败：${validation.errors.join('；')}`);
  const base=new URL(`${payload.cacheKey}/`,dir);await mkdir(base,{recursive:true});
  const releaseId=randomUUID(),file=`${releaseId}.json`,text=JSON.stringify(payload,null,2);
  await writeFile(new URL(file,base),text);
  const manifest={schemaVersion:1,cacheKey:payload.cacheKey,context:payload.context,releaseId,file,sha256:sha256(text),publishedAt:new Date().toISOString()};
  const pending=new URL(`${releaseId}.next.json`,base);await writeFile(pending,JSON.stringify(manifest,null,2));await rename(pending,new URL('manifest.json',base));
  console.log(JSON.stringify({status:'published',source:'中文机制资料库',documents:documents.length,augmentRules:normalized.rules.length,releaseId}));
  return {payload,manifest};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) syncLibrary(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
