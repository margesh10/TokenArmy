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

function summary() {
  let rows = [];
  try {
    rows = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return { events: 0, before: 0, after: 0, saved: 0, pct: 0, byKind: {} };
  }
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
  return { events: rows.length, before, after, saved: before - after, pct: before ? Math.round(((before - after) / before) * 100) : 0, byKind, file: FILE };
}

module.exports = { record, summary, FILE };
