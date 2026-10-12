// Offline packaging checks. Never reads ignored environment/credential files.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const files = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean));
const failures = [];
const schemas = fs.readdirSync('server/storage').filter(name => /^schema(?:-\d+)?\.sql$/.test(name));
for (const name of schemas) if (!files.has(`server/storage/${name}`)) failures.push(`Missing migration from release: ${name}`);
for (const file of files) {
  if (/(^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example') failures.push(`Private config in candidate files: ${file}`);
  if (fs.statSync(file).size >= 100 * 1024 * 1024) failures.push(`GitHub oversized file: ${file}`);
}
const docs = ['README.md', 'README.zh-CN.md', 'docs/ARCHITECTURE.md', 'docs/ARCHITECTURE.zh-CN.md', 'docs/SETUP.md', 'docs/SETUP.zh-CN.md'];
for (const file of docs) {
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) failures.push(`Broken link: ${file} -> ${target}`);
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(JSON.stringify({status:'ok', candidateFiles:files.size, migrationFiles:schemas.length, documentationFiles:docs.length}));
