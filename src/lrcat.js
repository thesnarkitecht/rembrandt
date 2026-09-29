// Lightroom Classic catalog (.lrcat, an SQLite database) reader. Returns each master photo with its
// folder path, rating, pick flag and develop settings, plus the regular collections. Nothing is
// written back; the catalog is only read.
import { crsToParams } from './xmp.js';

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
             f.baseName AS base, f.extension AS ext, fo.pathFromRoot AS folder, r.absolutePath AS root, r.name AS rootName,
             s.text AS settings
      FROM Adobe_images i
      JOIN AgLibraryFile f ON f.id_local = i.rootFile
      JOIN AgLibraryFolder fo ON fo.id_local = f.folder
      JOIN AgLibraryRootFolder r ON r.id_local = fo.rootFolder
      LEFT JOIN Adobe_imageDevelopSettings s ON s.image = i.id_local`);
    if (!rows) throw new Error("This doesn't look like a Lightroom Classic catalog");
    const cols = query(db, `SELECT id_local AS id, name FROM AgLibraryCollection WHERE creationId = 'com.adobe.ag.library.collection'`) || [];
    const links = query(db, 'SELECT collection, image FROM AgLibraryCollectionImage') || [];
    const colName = new Map(cols.map((c) => [c.id, c.name]));
    const inCols = new Map();
    for (const l of links) {
      const n = colName.get(l.collection);
      if (!n) continue;
      if (!inCols.has(l.image)) inCols.set(l.image, []);
      inCols.get(l.image).push(n);
    }
    const photos = [];
    const roots = new Map();
    let parseErrors = 0;
    for (const r of rows) {
      if (r.master) continue; // virtual copies
      const name = r.ext ? `${r.base}.${r.ext}` : r.base;
      let crs = null;
      if (r.settings) {
        try { crs = parseLua(r.settings); } catch { parseErrors++; }
      }
      const rel = joinPath(r.folder, name);
      photos.push({
        name,
        rel,
        path: joinPath(r.root, r.folder, name),
        root: r.root,
        rating: r.rating ? Math.round(r.rating) : 0,
        flag: r.pick > 0 ? 1 : r.pick < 0 ? -1 : 0,
        crs,
        collections: inCols.get(r.id) || [],
      });
      const k = r.root || '';
      roots.set(k, { path: r.root, name: r.rootName, count: (roots.get(k)?.count || 0) + 1 });
    }
    const collections = cols.filter((c) => [...inCols.values()].some((names) => names.includes(c.name))).map((c) => c.name);
    return { photos, collections, roots: [...roots.values()].sort((a, b) => b.count - a.count), parseErrors };
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
