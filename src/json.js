'use strict';
// JSON output compression (curl, gh api, kubectl -o json, aws, …).
// Arrays of similar objects become one header row + value rows, long arrays and strings are
// trimmed with counts, and any item mentioning an error/failure is always shown.
// Returns null when the text isn't a JSON document.
const { SIGNAL } = require('./squeeze-signal');

function crushJson(text, { maxItems = 15, maxStr = 160, maxDepth = 6, maxCols = 10 } = {}) {
  const t = String(text || '').trim();
  if (!/^[[{]/.test(t)) return null;
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    return null;
  }
  const str = (s) => (s.length > maxStr ? JSON.stringify(s.slice(0, maxStr)) + `…(+${s.length - maxStr} chars)` : JSON.stringify(s));
  const cell = (v) => {
    if (v === null || typeof v !== 'object') {
      const s = typeof v === 'string' ? v : String(v);
      return s.length > 40 ? s.slice(0, 40) + '…' : s;
    }
    if (Array.isArray(v)) return v.length <= 3 && v.every((x) => x === null || typeof x !== 'object') ? `[${v.join(',')}]` : `[${v.length}]`;
    const ks = Object.keys(v);
    // Small flat objects (owner: {login, id}) are worth inlining; bigger ones are just counted.
    if (ks.length <= 3 && ks.every((k) => v[k] === null || typeof v[k] !== 'object')) return ks.map((k) => `${k}=${cell(v[k])}`).join(',');
    return `{${ks.length} keys}`;
  };
  const isRowish = (a) => a.length >= 5 && a.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).length >= a.length * 0.8;
  const out = [];
  const pad = (d) => '  '.repeat(d);

  function render(v, d, label) {
    const pre = pad(d) + (label === '-' ? '- ' : label != null ? `${label}: ` : '');
    if (v === null || typeof v !== 'object') {
      out.push(pre + (typeof v === 'string' ? str(v) : String(v)));
      return;
    }
    if (d >= maxDepth) {
      out.push(pre + cell(v));
      return;
    }
    if (Array.isArray(v)) {
      if (!v.length) return out.push(pre + '[]');
      if (isRowish(v)) {
        // Columns: most frequent keys first.
        const freq = new Map();
        for (const o of v) if (o && typeof o === 'object') for (const k of Object.keys(o)) freq.set(k, (freq.get(k) || 0) + 1);
        const cols = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxCols).map(([k]) => k);
        const extra = freq.size - cols.length;
        out.push(pre + `[${v.length} items] ${cols.join(' | ')}${extra > 0 ? ` (+${extra} rarer keys)` : ''}`);
        const flagged = new Set(v.map((o, i) => (SIGNAL.test(JSON.stringify(o)) ? i : -1)).filter((i) => i >= 0));
        let shown = 0;
        v.forEach((o, i) => {
          if (i < maxItems || flagged.has(i)) {
            out.push(pad(d + 1) + '- ' + cols.map((c) => (o && c in o ? cell(o[c]) : '')).join(' | '));
            shown++;
          }
        });
        if (v.length > shown) out.push(pad(d + 1) + `… +${v.length - shown} more items`);
        return;
      }
      const limit = v.every((x) => x === null || typeof x !== 'object') ? maxItems * 2 : maxItems;
      out.push(pre + `[${v.length}]`);
      v.slice(0, limit).forEach((x) => render(x, d + 1, '-'));
      if (v.length > limit) out.push(pad(d + 1) + `… +${v.length - limit} more`);
      return;
    }
    const keys = Object.keys(v);
    if (!keys.length) return out.push(pre + '{}');
    if (label != null) out.push(pre.trimEnd());
    for (const k of keys) render(v[k], label != null ? d + 1 : d, k);
  }
  render(data, 0, null);
  return out.join('\n');
}

module.exports = { crushJson };
