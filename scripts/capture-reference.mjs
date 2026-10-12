// Research-only captures. Published Chinese facts are reviewed separately.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { resolve } from 'node:path';
setDefaultResultOrder('ipv4first');
const dir = resolve('tmp/v3-reference');
await mkdir(dir, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const clean = value => value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
async function capture(slug) {
  const path = resolve(dir, `${slug}.json`);
  try { return JSON.parse(await readFile(path, 'utf8')); } catch {}
  const url = `https://www.littlebuddybot.com/${slug}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${slug}: HTTP ${response.status}`);
  const html = await response.text(), fetchedAt = new Date().toISOString();
  const headings = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)].map(match => ({ text: clean(match[1]), index: match.index }));
  const links = [...new Set([...html.matchAll(/href="(\/tft-[a-z0-9-]+)"/g)].map(match => match[1].slice(1)))];
  const images = [];
  for (const match of html.matchAll(/<img\b[^>]*>/g)) {
    const src = match[0].match(/\bsrc="([^"]+)"/)?.[1];
    if (!src?.includes('assets.zyrosite.com') || !/\.png(?:\?|$)/.test(src)) continue;
    const original = src.replace(/\/cdn-cgi\/image\/[^/]+\//, '/').replace(/&amp;/g, '&');
    if (images.some(image => image.url === original)) continue;
    const imageResponse = await fetch(original, { signal: AbortSignal.timeout(30_000) });
    if (!imageResponse.ok) throw new Error(`Image HTTP ${imageResponse.status}: ${original}`);
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    const file = `${slug}-${images.length + 1}.png`;
    await writeFile(resolve(dir, file), bytes);
    images.push({ url: original, file, sha256: hash(bytes), bytes: bytes.length, fetchedAt: new Date().toISOString(), title: headings.filter(heading => heading.index < match.index).at(-1)?.text || '', alt: match[0].match(/\balt="([^"]*)"/)?.[1] || '' });
  }
  const record = { url, fetchedAt, sha256: hash(html), headings: headings.map(heading => heading.text), links, images };
  await writeFile(resolve(dir, `${slug}.html`), html);
  await writeFile(path, JSON.stringify(record, null, 2));
  return record;
}
const first = await capture('tft-trait-ladder');
console.log(JSON.stringify(first, null, 2));
if (process.argv.includes('--all')) {
  const slugs = first.links.filter(slug => !['tft-trait-ladder', 'tft-wisps', 'tft-augments', 'tft-timeline'].includes(slug));
  for (let i = 0; i < slugs.length; i += 4) {
    const records = await Promise.allSettled(slugs.slice(i, i + 4).map(capture));
    for (let j = 0; j < records.length; j++) {
      const record = records[j];
      console.log(JSON.stringify(record.status === 'fulfilled' ? { slug: slugs[i + j], headings: record.value.headings, images: record.value.images.map(image => ({ file: image.file, title: image.title })) } : { slug: slugs[i + j], error: record.reason.message }));
    }
  }
}
if (process.argv.includes('--rules')) {
  const page = await capture('tft-augments');
  const html = await readFile(resolve(dir, 'tft-augments.html'), 'utf8');
  const decode = value => value.replace(/&quot;/g, '"').replace(/&#(?:39|x27);/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const widgets = [];
  for (const match of html.matchAll(/<astro-island\b([^>]*)>/g)) {
    const props = match[1].match(/\bprops="([^"]*)"/)?.[1];
    if (!props) continue;
    const walk = value => { if (typeof value === 'string' && value.includes('SHEET_CSV_URL')) widgets.push(decode(value)); else if (value && typeof value === 'object') Object.values(value).forEach(walk); };
    walk(JSON.parse(decode(props)));
  }
  if (widgets.length !== 1) throw new Error('Augment public widget schema changed.');
  const url = widgets[0].match(/var SHEET_CSV_URL\s*=\s*"([^"]+)"/)?.[1];
  if (!url?.startsWith('https://docs.google.com/spreadsheets/d/e/')) throw new Error('No declared public CSV.');
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`CSV HTTP ${response.status}`);
  const csv = await response.text();
  await writeFile(resolve(dir, 'augment-rules.csv'), csv);
  await writeFile(resolve(dir, 'augment-widget.txt'), widgets[0]);
  const record = { pageUrl: page.url, pageFetchedAt: page.fetchedAt, pageSha256: page.sha256, url, fetchedAt: new Date().toISOString(), sha256: hash(csv) };
  await writeFile(resolve(dir, 'augment-rules-source.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
}
if (process.argv.includes('--bonus')) {
  const page = await capture('tft-bonus-gift');
  const html = (await readFile(resolve(dir,'tft-bonus-gift.html'),'utf8')).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
  const url = html.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[^\s<>"\\]+output=csv/)?.[0];
  if (!url) throw new Error('No Bonus Gift declared CSV.');
  const response = await fetch(url,{signal:AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error(`Bonus CSV HTTP ${response.status}`);
  const csv = await response.text();
  await writeFile(resolve(dir,'bonus-gift.csv'),csv);
  const record = {pageUrl:page.url,pageFetchedAt:page.fetchedAt,pageSha256:page.sha256,url,fetchedAt:new Date().toISOString(),sha256:hash(csv)};
  await writeFile(resolve(dir,'bonus-gift-source.json'),JSON.stringify(record,null,2));
  console.log(JSON.stringify(record));
}
if (process.argv.includes('--icons')) {
  const catalog = JSON.parse(await readFile('data/catalog.json', 'utf8'));
  const items = catalog.items.filter(item => ['artifact','radiant'].includes(item.category));
  const champions = catalog.champions;
  const list = [...items, ...champions];
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i,i+6).map(async item => {
      const file = `icon-${item.id}.png`;
      try { await readFile(resolve(dir,file)); return; } catch {}
      const response = await fetch(item.icon, {signal:AbortSignal.timeout(30_000)});
      if (!response.ok) return;
      await writeFile(resolve(dir,file),Buffer.from(await response.arrayBuffer()));
    }));
  }
  await writeFile(resolve(dir,'icon-index.json'),JSON.stringify(list.map(item=>({id:item.id,name:item.name,file:`icon-${item.id}.png`})),null,2));
  console.log(JSON.stringify({icons:list.length}));
}
