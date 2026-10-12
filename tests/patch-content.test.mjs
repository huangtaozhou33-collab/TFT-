import test from 'node:test';
import assert from 'node:assert/strict';
import {articleContent,officialImage} from '../server/patch-content.mjs';
import {parseArticle} from '../server/patch-notes.mjs';
const flatten=nodes=>nodes.flatMap(n=>[n,...flatten(n.children||[])]);
const image='https://cmsassets.rgpub.io/sanity/images/example.jpg';
test('rich articles preserve headings, nested lists, inline text and official image order',()=>{
 const content=articleContent(`<h2>版本概要</h2><p>改动 <strong>重点</strong><br>说明</p><img src="${image}" alt="改动图"><ul><li>英雄<ul><li>100 ⇒ 120</li></ul></li></ul>`);
 assert.deepEqual(content.map(n=>n.tag||n.type),['h2','p','image','ul']);
 assert.equal(content[2].src,image);assert.equal(content[3].children[0].children[1].tag,'ul');
 assert.ok(flatten(content).some(n=>n.text==='100 ⇒ 120'));
});
test('untrusted markup becomes safe data; scripts, handlers, nonofficial images and unsafe links cannot survive',()=>{
 const c=articleContent(`<script>bad()</script><iframe>bad()</iframe><svg onload="bad()"></svg><p onclick="bad()">安全</p><img src="https://evil.invalid/x"><a href="jav&#x61;script:bad()">链接文字</a><img src="${image}" onerror="bad()">`);
 const text=JSON.stringify(c);assert.ok(!text.includes('bad()'));assert.ok(!text.includes('evil.invalid'));assert.ok(text.includes('链接文字'));
 assert.equal(flatten(c).filter(n=>n.type==='image').length,1);
 assert.equal(officialImage('https://cmsassets.rgpub.io.evil.invalid/x'),null);
 assert.equal(officialImage('https://user:pass@cmsassets.rgpub.io/x'),null);
});
test('image-only revisions change the content fingerprint, and portrait decorations are excluded',()=>{
 const source={url:'https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/teamfight-tactics-patch-18-4/',locale:'en-us'};
 const html=src=>`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{page:{blades:[{type:'articleMasthead',title:'TFT 18.4',publishDate:'2026-10-06',banner:{url:image}},{type:'patchNotesRichText',richText:{body:`<div class="context-designers"><img src="${image}"></div><h2>调整</h2><p>${'说明'.repeat(100)}</p><img src="${src}">`}}]}}}})}</script>`;
 const a=parseArticle(html(image),source),b=parseArticle(html(image+'?revision=2'),source);
 assert.equal(a.cover.src,image);assert.equal(a.body,b.body);assert.notEqual(a.contentHash,b.contentHash);
 assert.equal(flatten(a.content).filter(n=>n.type==='image').length,1);
});
