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

const PROGRESS = /^\s*(\[[=#>\-\s.]+\]|[▏▎▍▌▋▊▉█░▒▓■□\s]{6,}|\d{1,3}(\.\d+)?%|[⠁-⣿]\s|(downloading|fetching|resolving|extracting|receiving objects|remote: (counting|compressing|enumerating)|compiling|building|progress))/i;

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

// Merge consecutive duplicate / same-shape lines: "line  (×42 similar)".
function dedupeRuns(lines, minRun = 3) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const sh = shape(lines[i]);
    let j = i + 1;
    while (j < lines.length && shape(lines[j]) === sh) j++;
    const run = j - i;
    if (run >= minRun && sh !== '') {
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
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (skipped) out.push(`  … [${skipped} lines omitted by tokenarmy]`);
      skipped = 0;
      out.push(lines[i]);
    } else skipped++;
  }
  if (skipped) out.push(`  … [${skipped} lines omitted by tokenarmy]`);
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

module.exports = { squeeze, stripAnsi, collapseCarriageReturns, dedupeRuns, smartTruncate, squashBlankLines, dropProgress, SIGNAL };
