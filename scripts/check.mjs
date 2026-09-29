// Syntax-checks every JavaScript module in the app and engine, and checks that every relative
// import points at a file that exists.
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';

const skip = new Set(['vendor', 'node_modules']);
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { if (!skip.has(f)) walk(p); } else if (f.endsWith('.js') || f.endsWith('.mjs')) files.push(p);
  }
};
['src', 'engine/src', 'scripts'].forEach(walk);
let bad = 0;
for (const f of files) {
  execFileSync('node', ['--check', f], { stdio: 'inherit' });
  for (const m of readFileSync(f, 'utf8').matchAll(/(?:import|export)[^'"`;]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = resolve(dirname(f), m[1] || m[2]);
    if (!existsSync(target)) { console.error(`${f}: missing import ${m[1] || m[2]}`); bad++; }
  }
}
if (bad) process.exit(1);
console.log(`${files.length} files OK`);
