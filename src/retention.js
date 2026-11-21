'use strict';
// Retention: raw outputs and per-session state are kept for KEEP_DAYS, then deleted.
// They exist so a compression can be undone during the work that produced it, not forever; and
// anything secret that slipped past redaction shouldn't sit on disk indefinitely.
// Runs at most once an hour (at session start). TOKENARMY_KEEP_DAYS=0 disables deletion.
const fs = require('fs');
const path = require('path');
const stats = require('./stats');

const HOME = path.dirname(stats.FILE);
const STAMP = path.join(HOME, '.last-prune');

function prune({ now = Date.now(), days = +(process.env.TOKENARMY_KEEP_DAYS ?? 7), force = false } = {}) {
  if (!(days > 0)) return { raw: 0, sessions: 0, skipped: true };
  try {
    if (!force && now - fs.statSync(STAMP).mtimeMs < 3600e3) return { raw: 0, sessions: 0, skipped: true };
  } catch {
    /* never pruned */
  }
  const cut = now - days * 864e5;
  const old = (p) => {
    try {
      return fs.statSync(p).mtimeMs < cut;
    } catch {
      return false;
    }
  };
  let raw = 0;
  let sessions = 0;
  const rawDir = path.join(HOME, 'raw');
  for (const f of safeList(rawDir)) {
    const p = path.join(rawDir, f);
    if (f.endsWith('.log') && old(p)) {
      try {
        fs.unlinkSync(p);
        raw++;
      } catch {
        /* in use */
      }
    }
  }
  const sessDir = path.join(HOME, 'sessions');
  for (const d of safeList(sessDir)) {
    const p = path.join(sessDir, d);
    // A session is old when nothing in it changed for KEEP_DAYS.
    const files = safeList(p).map((f) => path.join(p, f));
    if (files.length && !files.every(old)) continue;
    try {
      fs.rmSync(p, { recursive: true, force: true });
      sessions++;
    } catch {
      /* in use */
    }
  }
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(STAMP, String(now));
  } catch {
    /* best-effort */
  }
  return { raw, sessions, skipped: false };
}

function safeList(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

module.exports = { prune };
