// Assembles the static web app into dist/ (used by the desktop apps and rembrandt-server).
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
for (const p of ['index.html', 'auth-callback.html', 'styles.css', 'src', 'engine/src', 'models', 'LICENSE', 'NOTICE.md']) cpSync(p, `dist/${p}`, { recursive: true });
writeFileSync('dist/build-info.js', `window.LUMEN_BUILD = ${JSON.stringify({ date: process.env.LUMEN_BUILD_DATE || new Date().toISOString().slice(0, 10), version: JSON.parse(readFileSync('package.json', 'utf8')).version })};\n`);
// Optional service keys for the desktop apps (window.LUMEN_CONFIG = {…}), e.g. from a CI variable.
const config = process.env.LUMEN_CONFIG_JS ? '<script src="config.js"></script>\n  ' : '';
if (config) writeFileSync('dist/config.js', process.env.LUMEN_CONFIG_JS + '\n');
const html = readFileSync('dist/index.html', 'utf8').replace('<script type="module" src="src/splash.js"></script>', `${config}<script src="build-info.js"></script>\n  <script type="module" src="src/splash.js"></script>`);
writeFileSync('dist/index.html', html);
console.log('dist/ ready');
