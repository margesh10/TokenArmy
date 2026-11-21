'use strict';
// Context packing: give the model the *fewest* tokens that answer the query.
//   chunk()   – structure-aware chunking (markdown headings / code top-level blocks)
//   bm25      – lexical relevance, no embeddings or network needed
//   mmr()     – Maximal Marginal Relevance: drop near-duplicate chunks
//   pack()    – greedy knapsack under a hard token budget, keeps source order
//   outline() – code "skeleton": signatures only (often 80-95% smaller than the file)
//   graph     – import graph for code: rank files by hop distance from a seed (graph-RAG)

const fs = require('fs');
const path = require('path');
const { estimateTokens } = require('./tokens');

// ---------- chunking ----------
function chunk(text, { source = '', maxTokens = 400 } = {}) {
  const lines = String(text).split('\n');
  const isMd = /\.(md|mdx|txt|rst)$/i.test(source);
  const boundary = isMd
    ? (l) => /^#{1,4}\s/.test(l)
    : (l) => /^(export\s+)?(async\s+)?(function|class|def|interface|type|enum|struct|impl|fn|func|pub\s+fn|const\s+\w+\s*=\s*(async\s*)?\(|module\.exports)/.test(l);
  const chunks = [];
  let cur = [];
  let start = 1;
  const flush = (end) => {
    const body = cur.join('\n').trim();
    if (body) chunks.push({ source, start, end, text: body, tokens: estimateTokens(body) });
    cur = [];
  };
  let curTokens = 0;
  lines.forEach((l, i) => {
    if ((boundary(l) && cur.length) || curTokens > maxTokens) {
      flush(i);
      start = i + 1;
      curTokens = 0;
    }
    cur.push(l);
    curTokens += estimateTokens(l) + 1;
  });
  flush(lines.length);
  return chunks;
}

// ---------- BM25 ----------
function tokenize(s) {
  return String(s)
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9_]+/)
    .flatMap((w) => w.split('_'))
    .filter((w) => w.length > 1);
}

function bm25(chunks, query, { k1 = 1.4, b = 0.75 } = {}) {
  const docs = chunks.map((c) => tokenize(c.text + ' ' + c.source));
  const N = docs.length || 1;
  const avg = docs.reduce((a, d) => a + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const q = [...new Set(tokenize(query))];
  return chunks.map((c, i) => {
    const d = docs[i];
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return { ...c, score: s };
  });
}

// ---------- MMR (dedupe by Jaccard similarity) ----------
function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

function mmr(scored, { lambda = 0.7, k = 50 } = {}) {
  const pool = scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  const maxS = pool[0] ? pool[0].score : 1;
  const picked = [];
  while (pool.length && picked.length < k) {
    let best = 0;
    let bestVal = -Infinity;
    pool.forEach((c, i) => {
      const sim = picked.length ? Math.max(...picked.map((p) => jaccard(p.text, c.text))) : 0;
      const val = lambda * (c.score / maxS) - (1 - lambda) * sim;
      if (val > bestVal) {
        bestVal = val;
        best = i;
      }
    });
    const [c] = pool.splice(best, 1);
    if (picked.some((p) => jaccard(p.text, c.text) > 0.85)) continue; // near-duplicate
    picked.push(c);
  }
  return picked;
}

// ---------- budget packing ----------
function pack(chunks, query, budget = 4000) {
  const ranked = mmr(bm25(chunks, query));
  const chosen = [];
  let used = 0;
  for (const c of ranked) {
    const cost = c.tokens + 8; // header overhead
    if (used + cost > budget) continue;
    chosen.push(c);
    used += cost;
  }
  // Re-order by source position: models read coherent order better ("lost in the middle" mitigation:
  // the single best chunk goes first, the rest in document order).
  const [top, ...rest] = chosen;
  rest.sort((a, b) => (a.source === b.source ? a.start - b.start : a.source.localeCompare(b.source)));
  const final = top ? [top, ...rest] : [];
  const text = final.map((c) => `### ${c.source}:${c.start}-${c.end}\n${c.text}`).join('\n\n');
  return { text, used, chunks: final.length, considered: chunks.length };
}

// ---------- code outline ----------
function outline(code, source = '') {
  const ext = path.extname(source).toLowerCase();
  const lines = String(code).split('\n');
  const keep = [];
  const sig =
    ext === '.py'
      ? /^\s*(class |def |async def |@\w)/
      : /^\s*(export |import |from |module\.exports|(async\s+)?function\b|class\b|interface\b|type\s+\w+\s*=|enum\b|(public|private|protected|static)\s+[\w<>\[\]]+\s+\w+\s*\(|(pub\s+)?(fn|struct|trait|impl|mod)\b|func\b|package\b|const\s+\w+\s*=\s*(async\s*)?(\(|function)|\w+\s*\([^)]*\)\s*\{\s*$)/;
  lines.forEach((l, i) => {
    if (sig.test(l)) keep.push(`${String(i + 1).padStart(4)}| ${l.replace(/\s*\{\s*$/, ' { … }').trimEnd()}`);
  });
  return keep.join('\n');
}

// ---------- import graph (graph-RAG for code) ----------
const IMPORT_RES = [
  /\bimport\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*from\s+(\.[\w.]*)\s+import/gm,
];
const EXTS = ['', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '/index.js', '/index.ts', '/__init__.py'];

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // external package
  let rel = spec;
  if (/^\.+[\w.]*$/.test(spec) && fromFile.endsWith('.py')) {
    const dots = spec.match(/^\.+/)[0].length;
    rel = '../'.repeat(dots - 1) + './' + spec.slice(dots).replace(/\./g, '/');
  }
  const base = path.resolve(path.dirname(fromFile), rel);
  for (const e of EXTS) {
    const p = base + e;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function buildGraph(files) {
  const edges = new Map();
  for (const f of files) {
    let src = '';
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const out = new Set();
    for (const re of IMPORT_RES) {
      for (const m of src.matchAll(re)) {
        const r = resolveImport(f, m[1]);
        if (r) out.add(r);
      }
    }
    edges.set(f, out);
  }
  return edges;
}

// BFS over imports and reverse imports; returns [{file, hops}]
function neighbourhood(graph, seed, maxHops = 2) {
  const rev = new Map();
  for (const [f, outs] of graph) for (const o of outs) (rev.get(o) || rev.set(o, new Set()).get(o)).add(f);
  const seen = new Map([[seed, 0]]);
  const q = [seed];
  while (q.length) {
    const f = q.shift();
    const h = seen.get(f);
    if (h >= maxHops) continue;
    for (const n of [...(graph.get(f) || []), ...(rev.get(f) || [])]) {
      if (!seen.has(n)) {
        seen.set(n, h + 1);
        q.push(n);
      }
    }
  }
  return [...seen].map(([file, hops]) => ({ file, hops })).sort((a, b) => a.hops - b.hops);
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.cache', 'vendor']);
function walk(dir, exts, out = [], limit = 5000) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= limit) break;
    if (e.name.startsWith('.') && e.name !== '.claude' && e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(p, exts, out, limit);
    } else if (!exts || exts.test(e.name)) out.push(p);
  }
  return out;
}

module.exports = { chunk, tokenize, bm25, mmr, pack, outline, buildGraph, neighbourhood, walk, jaccard, IGNORE_DIRS };
