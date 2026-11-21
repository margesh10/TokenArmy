'use strict';
// Local-only savings ledger (~/.tokenarmy/gain.jsonl). Nothing is ever sent anywhere.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = process.env.TOKENARMY_HOME || path.join(os.homedir(), '.tokenarmy');
const FILE = path.join(DIR, 'gain.jsonl');

// The live ledger is read on every hook call and status-line refresh, so it must stay small.
// Past MAX_BYTES, rows older than KEEP_MS are folded into ARCHIVE (running totals), which keeps
// `gain` all-time while the live file only holds recent rows.
const ARCHIVE = path.join(DIR, 'gain-archive.json');
const MAX_BYTES = +(process.env.TOKENARMY_LEDGER_MAX_KB || 1024) * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;
const NON_SAVING = new Set(['expand', 'checkpoint', 'loop', 'facts']);

function emptyArchive() {
  return { events: 0, before: 0, after: 0, byKind: {}, expands: 0, checkpoints: 0, loops: 0, rotated: 0 };
}

function readArchive() {
  try {
    return { ...emptyArchive(), ...JSON.parse(fs.readFileSync(ARCHIVE, 'utf8')) };
  } catch {
    return emptyArchive();
  }
}

function fold(arch, rows) {
  arch.families = arch.families || {};
  for (const r of rows) {
    // Per-project family counts for the learning loop (src/learn.js autoBypassed).
    if (r.family && (r.kind === 'expand' || /^(hook|run):/.test(r.kind || ''))) {
      const key = `${String(r.proj || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}\u0000${r.family}`;
      const f = (arch.families[key] = arch.families[key] || { compressed: 0, expanded: 0, last: 0 });
      if (r.kind === 'expand') f.expanded++;
      else f.compressed++;
      f.last = Math.max(f.last, Date.parse(r.at) || 0);
    }
    if (r.kind === 'expand') arch.expands++;
    else if (r.kind === 'checkpoint') arch.checkpoints++;
    else if (r.kind === 'loop') arch.loops++;
    if (NON_SAVING.has(r.kind)) continue;
    arch.events++;
    arch.before += r.before || 0;
    arch.after += r.after || 0;
    const k = r.kind || 'other';
    const b = (arch.byKind[k] = arch.byKind[k] || { events: 0, saved: 0 });
    b.events++;
    b.saved += (r.before || 0) - (r.after || 0);
  }
  return arch;
}

function rotate(now = Date.now()) {
  const rows = readRows() || [];
  const cut = now - KEEP_MS;
  const old = rows.filter((r) => !(Date.parse(r.at) >= cut));
  if (!old.length) return false;
  const keep = rows.filter((r) => Date.parse(r.at) >= cut);
  const arch = fold(readArchive(), old);
  arch.rotated = (arch.rotated || 0) + old.length;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(ARCHIVE, JSON.stringify(arch));
  fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
  fs.renameSync(tmp, FILE);
  return true;
}

function record(entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    if (fs.statSync(FILE).size > MAX_BYTES) rotate();
  } catch {
    /* stats are best-effort */
  }
}

function readRows() {
  try {
    return fs
      .readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return null;
  }
}

// opts.session: only count events recorded in that Claude Code session.
function summary(opts = {}) {
  let rows = readRows() || [];
  if (opts.session) rows = rows.filter((r) => r.session === opts.session);
  const factStarts = rows.filter((r) => r.kind === 'facts').length;
  // Session totals come from the live file only (sessions are recent); all-time adds the archive.
  const t = fold(opts.session ? emptyArchive() : readArchive(), rows);
  const { events, before, after, byKind, expands, checkpoints, loops } = t;
  return { events, before, after, saved: before - after, pct: before ? Math.round(((before - after) / before) * 100) : 0, byKind, expands, checkpoints, loops, factStarts, file: FILE };
}

module.exports = { record, summary, readRows, rotate, readArchive, FILE, ARCHIVE };
