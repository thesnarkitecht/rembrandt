// Lightroom Classic catalog (.lrcat, an SQLite database) reader. Returns each master photo with its
// folder path, rating, pick flag, colour label, keywords, develop settings and virtual copies, plus
// the regular collections (inside collection sets, named "Set › Collection"), and a tally of what
// Rembrandt can't bring over. Nothing is written back; the catalog is only read.
import { crsToParams, untranslated } from './xmp.js';

let sqlp = null;
function loadSql() {
  if (sqlp) return sqlp;
  sqlp = new Promise((resolve, reject) => {
    const base = new URL('./vendor/sqljs/', import.meta.url).href;
    const done = () => globalThis.initSqlJs({ locateFile: (f) => base + f }).then(resolve, reject);
    if (globalThis.initSqlJs) { done(); return; }
    const s = document.createElement('script');
    s.src = base + 'sql-wasm.js';
    s.onload = done;
    s.onerror = () => reject(new Error('Could not load the catalog reader'));
    document.head.append(s);
  });
  sqlp.catch(() => { sqlp = null; });
  return sqlp;
}

// ------------------------------------------------------------ Lua table parser
// Develop settings are stored as a serialised Lua table: `s = { Exposure2012 = 0.5, … }`.
export function parseLua(text) {
  let i = 0;
  const src = String(text || '');
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('--', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
      return;
    }
  };
  const longStr = () => {
    const m = /^\[(=*)\[/.exec(src.slice(i, i + 32));
    if (!m) return null;
    const close = `]${m[1]}]`;
    const start = i + m[0].length;
    const end = src.indexOf(close, start);
    i = end < 0 ? src.length : end + close.length;
    return src.slice(start, end < 0 ? src.length : end).replace(/^\n/, '');
  };
  const str = () => {
    const q = src[i++];
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const c = src[++i];
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
        i++;
      } else out += src[i++];
    }
    i++;
    return out;
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") return str();
    if (c === '[') { const l = longStr(); if (l !== null) return l; }
    const m = /^(-?(?:0x[0-9a-f]+|\d*\.?\d+(?:e[+-]?\d+)?)|true|false|nil)/i.exec(src.slice(i, i + 64));
    if (!m) throw new Error(`Unexpected "${src.slice(i, i + 12)}"`);
    i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    if (m[0] === 'nil') return null;
    return Number(m[0]);
  };
  const table = () => {
    i++; // {
    const obj = {};
    const arr = [];
    for (;;) {
      ws();
      if (src[i] === '}') { i++; break; }
      let key = null;
      if (src[i] === '[' && !/^\[=*\[/.test(src.slice(i, i + 8))) {
        i++;
        key = value();
        ws();
        i++; // ]
        ws();
        i++; // =
      } else {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(src.slice(i, i + 128));
        if (m) { key = m[1]; i += m[0].length; }
      }
      const v = value();
      if (key === null) arr.push(v); else obj[key] = v;
      ws();
      if (src[i] === ',' || src[i] === ';') i++;
      if (i >= src.length) break;
    }
    return Object.keys(obj).length || !arr.length ? (arr.length ? Object.assign(obj, { _list: arr }) : obj) : arr;
  };
  const eq = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.exec(src);
  if (eq) i = eq[0].length;
  return value();
}

// ------------------------------------------------------------ catalog
const query = (db, sql) => {
  try {
    const res = db.exec(sql)[0];
    if (!res) return [];
    return res.values.map((row) => Object.fromEntries(res.columns.map((c, k) => [c, row[k]])));
  } catch (e) {
    console.warn('lrcat query failed', e.message);
    return null;
  }
};

const joinPath = (...parts) => parts.filter(Boolean).join('').replace(/\\/g, '/').replace(/\/{2,}/g, '/');

// Reads a catalog File. `onProgress(text)` is called for long steps.
export async function readCatalog(file, onProgress = () => {}) {
  if (!/\.lrcat$/i.test(file.name)) throw new Error('Choose a Lightroom Classic catalog (.lrcat)');
  onProgress('Loading the catalog reader…');
  const SQL = await loadSql();
  onProgress('Reading the catalog…');
  const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  try {
    const rows = query(db, `
      SELECT i.id_local AS id, i.rating AS rating, i.pick AS pick, i.masterImage AS master,
             i.colorLabels AS label, i.copyName AS copyName,
             f.baseName AS base, f.extension AS ext, fo.pathFromRoot AS folder, r.absolutePath AS root, r.name AS rootName,
             s.text AS settings
      FROM Adobe_images i
      JOIN AgLibraryFile f ON f.id_local = i.rootFile
      JOIN AgLibraryFolder fo ON fo.id_local = f.folder
      JOIN AgLibraryRootFolder r ON r.id_local = fo.rootFolder
      LEFT JOIN Adobe_imageDevelopSettings s ON s.image = i.id_local`);
    if (!rows) throw new Error("This doesn't look like a Lightroom Classic catalog");
    // Collections, with the names of the collection sets they sit in.
    const allCols = query(db, 'SELECT id_local AS id, name, parent, creationId AS kind FROM AgLibraryCollection') || [];
    const byId = new Map(allCols.map((c) => [c.id, c]));
    const path = (c) => { const names = []; for (let x = c, n = 0; x && n < 12; x = byId.get(x.parent), n++) names.unshift(x.name); return names.join(' › '); };
    const cols = allCols.filter((c) => c.kind === 'com.adobe.ag.library.collection').map((c) => ({ id: c.id, name: path(c) }));
    const smart = allCols.filter((c) => c.kind === 'com.adobe.ag.library.smart_collection').length;
    const links = query(db, 'SELECT collection, image FROM AgLibraryCollectionImage') || [];
    const colName = new Map(cols.map((c) => [c.id, c.name]));
    const inCols = new Map();
    for (const l of links) {
      const n = colName.get(l.collection);
      if (!n) continue;
      if (!inCols.has(l.image)) inCols.set(l.image, []);
      inCols.get(l.image).push(n);
    }
    // Keywords (the leaf names; Lightroom's hierarchy is kept only as the name).
    const kw = query(db, 'SELECT ki.image AS image, k.name AS name FROM AgLibraryKeywordImage ki JOIN AgLibraryKeyword k ON k.id_local = ki.tag WHERE k.name IS NOT NULL') || [];
    const keywords = new Map();
    for (const k of kw) { if (!keywords.has(k.image)) keywords.set(k.image, []); keywords.get(k.image).push(k.name); }
    const LABELS = { red: 'red', yellow: 'yellow', green: 'green', blue: 'blue', purple: 'purple', rot: 'red', gelb: 'yellow', grün: 'green', blau: 'blue', lila: 'purple' };
    const label = (v) => LABELS[String(v || '').trim().toLowerCase()] || '';
    const photos = [];
    const roots = new Map();
    const missing = new Map();   // what Rembrandt doesn't translate → number of photos
    let parseErrors = 0;
    const describe = (r) => {
      let crs = null;
      if (r.settings) {
        try { crs = parseLua(r.settings); } catch { parseErrors++; }
      }
      if (crs) for (const m of untranslated(crs)) missing.set(m, (missing.get(m) || 0) + 1);
      return {
        rating: r.rating ? Math.round(r.rating) : 0,
        flag: r.pick > 0 ? 1 : r.pick < 0 ? -1 : 0,
        label: label(r.label),
        keywords: keywords.get(r.id) || [],
        crs,
        collections: inCols.get(r.id) || [],
      };
    };
    const byMaster = new Map();
    for (const r of rows) {
      if (r.master) continue;
      const name = r.ext ? `${r.base}.${r.ext}` : r.base;
      const rel = joinPath(r.folder, name);
      const p = { name, rel, path: joinPath(r.root, r.folder, name), root: r.root, ...describe(r), copies: [] };
      photos.push(p);
      byMaster.set(r.id, p);
      const k = r.root || '';
      roots.set(k, { path: r.root, name: r.rootName, count: (roots.get(k)?.count || 0) + 1 });
    }
    // Virtual copies: their own edits, ratings and labels on their master's file.
    let copies = 0;
    for (const r of rows) {
      const m = r.master && byMaster.get(r.master);
      if (!m) continue;
      m.copies.push({ name: r.copyName || `Copy ${m.copies.length + 1}`, ...describe(r) });
      copies++;
    }
    const collections = cols.filter((c) => [...inCols.values()].some((names) => names.includes(c.name))).map((c) => c.name);
    const report = { copies, smart, keywords: photos.filter((p) => p.keywords.length).length, labels: photos.filter((p) => p.label).length, missing: [...missing].sort((a, b) => b[1] - a[1]) };
    return { photos, collections, roots: [...roots.values()].sort((a, b) => b.count - a.count), parseErrors, report };
  } finally {
    db.close();
  }
}

// Index for matching files found on disk to catalog photos: by path suffix, then by name.
export function catalogIndex(cat) {
  const byName = new Map();
  for (const p of cat.photos) {
    const k = p.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }
  return {
    // `rel` is the file's path inside the folder the user picked (may be just the name);
    // `size` (bytes), when known, tells apart different photos with the same name.
    match(name, rel = '', size = 0) {
      let list = byName.get(name.toLowerCase());
      if (!list) return null;
      if (size && list.length > 1 && list.some((p) => p.size)) {
        const same = list.filter((p) => p.size === size);
        if (same.length) list = same;
      }
      if (list.length === 1) return list[0];
      const r = rel.replace(/\\/g, '/').toLowerCase();
      let best = null, bestLen = -1;
      for (const p of list) {
        const pr = p.path.toLowerCase();
        let n = 0;
        while (n < r.length && n < pr.length && r[r.length - 1 - n] === pr[pr.length - 1 - n]) n++;
        if (n > bestLen) { best = p; bestLen = n; }
      }
      return best;
    },
    settingsFor(p, aspect) { return p?.crs ? crsToParams(p.crs, aspect) : null; },
  };
}
