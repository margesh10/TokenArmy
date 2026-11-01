'use strict';
// Search-output compression: group hits by file, keep the first few per file, count the rest,
// truncate very long lines (minified files, lockfiles). Works on Claude Code Grep "content" mode
// (path:line:text or path:line-text) and grep/rg/Select-String output.
const { SIGNAL } = require('./squeeze-signal');

const LINE = /^(.+?)([:-])(\d+)[:-](.*)$/; // file:12:text  |  file-12-text (context lines)

function compressSearch(text, { perFile = 4, maxFiles = 40, maxLine = 200 } = {}) {
  const lines = String(text || '').split('\n').filter((l) => l !== '' && l !== '--');
  const files = new Map();
  const loose = [];
  for (const l of lines) {
    const m = l.match(LINE);
    if (!m || /^\s/.test(m[1])) {
      loose.push(l);
      continue;
    }
    if (!files.has(m[1])) files.set(m[1], []);
    files.get(m[1]).push({ no: m[3], text: m[4], match: m[2] === ':' });
  }
  if (files.size === 0) return null; // not search output we understand
  const trunc = (s) => (s.length > maxLine ? s.slice(0, maxLine) + ` …(+${s.length - maxLine} chars)` : s);
  const out = [];
  let shownFiles = 0;
  let hiddenHits = 0;
  let hiddenFiles = 0;
  const total = [...files.values()].reduce((a, h) => a + h.filter((x) => x.match).length, 0);
  for (const [file, hits] of files) {
    const matches = hits.filter((h) => h.match);
    if (shownFiles >= maxFiles) {
      hiddenFiles++;
      hiddenHits += matches.length;
      continue;
    }
    shownFiles++;
    // Signal-bearing hits (errors etc.) are always shown, then the first few others.
    const keep = matches.filter((h) => SIGNAL.test(h.text));
    for (const h of matches) if (keep.length < perFile && !keep.includes(h)) keep.push(h);
    keep.sort((a, b) => a.no - b.no);
    out.push(`${file} (${matches.length} match${matches.length === 1 ? '' : 'es'})`);
    for (const h of keep) out.push(`  ${h.no}: ${trunc(h.text.trim())}`);
    if (matches.length > keep.length) out.push(`  … +${matches.length - keep.length} more in this file`);
  }
  if (hiddenFiles) out.push(`… +${hiddenHits} matches in ${hiddenFiles} more files`);
  for (const l of loose.slice(0, 20)) out.push(trunc(l));
  if (loose.length > 20) out.push(`… +${loose.length - 20} other lines`);
  out.unshift(`[tokenarmy] ${total} matches in ${files.size} files (grouped by file)`);
  return out.join('\n');
}

// files_with_matches / count modes: a long list of paths.
function compressList(text, { max = 60 } = {}) {
  const lines = String(text || '').split('\n').filter(Boolean);
  if (lines.length <= max) return null;
  return [...lines.slice(0, max), `… +${lines.length - max} more (${lines.length} total)`].join('\n');
}

module.exports = { compressSearch, compressList };
