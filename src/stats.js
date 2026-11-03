'use strict';
// Local-only savings ledger (~/.tokenarmy/gain.jsonl). Nothing is ever sent anywhere.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = process.env.TOKENARMY_HOME || path.join(os.homedir(), '.tokenarmy');
const FILE = path.join(DIR, 'gain.jsonl');

function record(entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
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
  let rows = readRows();
  if (!rows) return { events: 0, before: 0, after: 0, saved: 0, pct: 0, byKind: {}, expands: 0, checkpoints: 0, file: FILE };
  if (opts.session) rows = rows.filter((r) => r.session === opts.session);
  // Non-saving events: the agent opening a raw log, checkpoint restores, loop notes, facts stated.
  const expands = rows.filter((r) => r.kind === 'expand').length;
  const checkpoints = rows.filter((r) => r.kind === 'checkpoint').length;
  const loops = rows.filter((r) => r.kind === 'loop').length;
  const factStarts = rows.filter((r) => r.kind === 'facts').length;
  const INFO = new Set(['expand', 'checkpoint', 'loop', 'facts']);
  rows = rows.filter((r) => !INFO.has(r.kind));
  const byKind = {};
  let before = 0;
  let after = 0;
  for (const r of rows) {
    before += r.before || 0;
    after += r.after || 0;
    const k = r.kind || 'other';
    byKind[k] = byKind[k] || { events: 0, saved: 0 };
    byKind[k].events++;
    byKind[k].saved += (r.before || 0) - (r.after || 0);
  }
  return { events: rows.length, before, after, saved: before - after, pct: before ? Math.round(((before - after) / before) * 100) : 0, byKind, expands, checkpoints, loops, factStarts, file: FILE };
}

module.exports = { record, summary, readRows, FILE };
