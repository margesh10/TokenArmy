'use strict';
// Generic, lossless-where-it-matters compression for tool / command output.
// Principle: the model needs signal (errors, failures, diffs, summaries),
// not noise (progress bars, ANSI colour, repeated lines, passing tests).

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][AB012]/g;
const { SIGNAL } = require('./squeeze-signal');

function stripAnsi(s) {
  return s.replace(ANSI, '');
}

// Collapse carriage-return overwrites (progress bars) to the final frame.
function collapseCarriageReturns(s) {
  return s
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      return parts[parts.length - 1] || parts[parts.length - 2] || '';
    })
    .join('\n');
}

const PROGRESS = /^\s*(\[[=#>\-\s.]+\]|[▏▎▍▌▋▊▉█░▒▓■□]{6,}|\d{1,3}(\.\d+)?%|[⠁-⣿]\s|(downloading|fetching|resolving|extracting|receiving objects|remote: (counting|compressing|enumerating)|compiling|building|progress))/i;

function dropProgress(lines) {
  return lines.filter((l) => !(PROGRESS.test(l) && !SIGNAL.test(l)));
}

// Normalise volatile tokens so near-identical lines can be grouped.
function shape(line) {
  return line
    .replace(/0x[0-9a-f]+/gi, '0x#')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '#h')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/(["'`]).*?\1/g, '$1…$1')
    .trim();
}

// What a run of hidden lines had in common, computed from exactly those lines (after caveman's
// "class-invariant elision summaries"). A bare count makes the agent wonder whether something it
// needs was hidden, and it re-opens the raw log; a summary answers that without the lines:
//   levels   INFO×200 DEBUG×14              (log levels, exact counts)
//   fields   status: 200×210 404×4          (key=value present in EVERY line: constant, ≤4 values
//            ms=3..812                       with exact counts, or a numeric range of the originals)
//   signal   "no problem lines" or "3 problem lines among them" (SIGNAL matches are never hidden silently)
// Nothing partial is ever printed: a field with too many values, or values that are not all
// numbers, is left out entirely rather than listed incompletely. Deterministic, so the same
// output always compresses to the same text (prompt-cache friendly).
const LEVEL = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL)\b|\blevel=(\w+)/;
const KV = /(?:^|[\s,{(])([A-Za-z_][\w.-]{0,30})=("[^"]*"|[^\s,)}]+)/g;

function describe(lines, { maxFields = 3 } = {}) {
  if (lines.length < 3) return '';
  const parts = [];
  const levels = new Map();
  for (const l of lines) {
    const m = l.match(LEVEL);
    if (m) {
      const lv = (m[1] || m[2]).toUpperCase().replace(/^WARNING$/, 'WARN');
      levels.set(lv, (levels.get(lv) || 0) + 1);
    }
  }
  if (levels.size && [...levels.values()].reduce((a, b) => a + b, 0) >= lines.length * 0.6) parts.push([...levels].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' '));

  // key=value fields that appear in every hidden line.
  const rows = lines.map((l) => {
    const f = new Map();
    for (const m of l.matchAll(KV)) if (!f.has(m[1])) f.set(m[1], m[2].replace(/^"|"$/g, ''));
    return f;
  });
  const keys = [...rows[0].keys()].filter((k) => k !== 'level' && rows.every((r) => r.has(k)));
  const fields = [];
  for (const k of keys) {
    const vals = rows.map((r) => r.get(k));
    const distinct = new Map();
    for (const v of vals) distinct.set(v, (distinct.get(v) || 0) + 1);
    if (distinct.size === 1) fields.push({ rank: 1, text: `${k}=${vals[0]}` });
    else if (distinct.size <= 4 && [...distinct.keys()].every((v) => v.length <= 24) && distinct.size < vals.length) fields.push({ rank: 0, text: `${k}: ${[...distinct].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`).join(' ')}` });
    else if (vals.every((v) => /^-?\d+(\.\d+)?[a-zµ%]*$/i.test(v)) && new Set(vals.map((v) => v.replace(/^[-\d.]+/, ''))).size === 1) {
      // Numbers with one shared unit only: "1s" and "200ms" have no honest common range.
      const num = (v) => parseFloat(v);
      const lo = vals.reduce((a, b) => (num(b) < num(a) ? b : a));
      const hi = vals.reduce((a, b) => (num(b) > num(a) ? b : a));
      fields.push({ rank: 2, text: `${k}=${lo}..${hi}` });
    }
  }
  fields.sort((a, b) => a.rank - b.rank);
  for (const f of fields.slice(0, maxFields)) parts.push(f.text);

  const sig = lines.filter((l) => SIGNAL.test(l)).length;
  // Worded without SIGNAL words, so the marker itself never looks like an error line.
  parts.push(sig ? `${sig} problem line${sig === 1 ? '' : 's'} among them` : 'no problem lines');
  return parts.join('; ');
}

// Merge consecutive duplicate / same-shape lines: first line, "… (N more similar lines)", last line.
// The last line is kept because it usually carries the final state (the last progress frame, the
// highest counter).
function dedupeRuns(lines, minRun = 3) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const sh = shape(lines[i]);
    let j = i + 1;
    while (j < lines.length && shape(lines[j]) === sh) j++;
    const run = j - i;
    if (run >= 4 && sh !== '') {
      const hidden = lines.slice(i + 1, j - 1);
      const why = describe(hidden);
      out.push(lines[i]);
      out.push(`  … (${hidden.length} more similar line${hidden.length === 1 ? '' : 's'}${why ? `: ${why}` : ''})`);
      out.push(lines[j - 1]);
    } else if (run >= minRun && sh !== '') {
      out.push(lines[i]);
      out.push(`  … (${run - 1} more similar line${run - 1 === 1 ? '' : 's'})`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out;
}

function squashBlankLines(lines) {
  const out = [];
  for (const l of lines) {
    const blank = l.trim() === '';
    if (blank && (out.length === 0 || out[out.length - 1].trim() === '')) continue;
    out.push(blank ? '' : l.replace(/\s+$/, ''));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

// Keep head, tail and every signal line (plus context) in the middle.
function smartTruncate(lines, maxLines = 120, ctx = 2) {
  if (lines.length <= maxLines) return lines;
  const head = Math.floor(maxLines * 0.3);
  const tail = Math.floor(maxLines * 0.4);
  const keep = new Set();
  for (let i = 0; i < head; i++) keep.add(i);
  for (let i = lines.length - tail; i < lines.length; i++) keep.add(i);
  let budget = maxLines - head - tail;
  for (let i = head; i < lines.length - tail && budget > 0; i++) {
    if (SIGNAL.test(lines[i])) {
      for (let k = Math.max(head, i - ctx); k <= Math.min(lines.length - tail - 1, i + ctx); k++) {
        if (!keep.has(k)) {
          keep.add(k);
          budget--;
        }
      }
    }
  }
  const out = [];
  let skipped = [];
  const marker = () => {
    const why = describe(skipped);
    out.push(`  … [${skipped.length} lines omitted by tokenarmy${why ? `: ${why}` : ''}]`);
    skipped = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (skipped.length) marker();
      out.push(lines[i]);
    } else skipped.push(lines[i]);
  }
  if (skipped.length) marker();
  return out;
}

function squeeze(text, opts = {}) {
  const { maxLines = 120, filters = true, command = '' } = opts;
  let s = collapseCarriageReturns(stripAnsi(String(text || '')).replace(/\r\n/g, '\n'));
  if (filters) {
    const { applyFilter } = require('./filters');
    const filtered = applyFilter(command, s);
    if (filtered != null) s = filtered;
  }
  let lines = s.split('\n');
  lines = dropProgress(lines);
  lines = squashBlankLines(lines);
  lines = dedupeRuns(lines);
  lines = smartTruncate(lines, maxLines);
  return lines.join('\n');
}

module.exports = { squeeze, stripAnsi, collapseCarriageReturns, dedupeRuns, smartTruncate, squashBlankLines, dropProgress, describe, SIGNAL };
