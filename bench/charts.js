'use strict';
// Dependency-free SVG charts for the README (light + dark variants).
// GitHub renders SVG <img> without scripts, so charts are static: every value is
// direct-labelled and the same numbers are in the README tables (the table view).
// Palette: validated categorical slots 1-2 (blue/orange), light + dark steps.

const fs = require('fs');
const path = require('path');

const THEMES = {
  light: { surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', s1: '#2a78d6', s2: '#eb6834', border: 'rgba(11,11,11,0.10)' },
  dark: { surface: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', s1: '#3987e5', s2: '#d95926', border: 'rgba(255,255,255,0.10)' },
};
const FONT = 'system-ui, -apple-system, &quot;Segoe UI&quot;, Helvetica, Arial, sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n))).replace(/\.0(?=[Mk])/, '');

function frame(w, h, t, body, title, subtitle) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="${t.surface}" stroke="${t.border}"/>
<text x="24" y="34" font-family="${FONT}" font-size="16" font-weight="600" fill="${t.ink}">${esc(title)}</text>
${subtitle ? `<text x="24" y="54" font-family="${FONT}" font-size="12" fill="${t.ink2}">${esc(subtitle)}</text>` : ''}
${body}
</svg>
`;
}

// Bar with a 4px rounded data-end (right), square at the baseline (left).
function hbar(x, y, w, h, r, fill) {
  if (w <= r) return `<rect x="${x}" y="${y}" width="${Math.max(w, 1)}" height="${h}" fill="${fill}"/>`;
  return `<path d="M${x},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} z" fill="${fill}"/>`;
}

function savingsChart(rows, t) {
  const data = [...rows].sort((a, b) => b.pct - a.pct);
  const W = 860, left = 250, right = 170, top = 78, rowH = 30, barH = 16;
  const plotW = W - left - right;
  const H = top + data.length * rowH + 40;
  let g = '';
  for (const v of [0, 25, 50, 75, 100]) {
    const x = left + (plotW * v) / 100;
    g += `<line x1="${x}" y1="${top - 8}" x2="${x}" y2="${top + data.length * rowH - 6}" stroke="${v === 0 ? t.axis : t.grid}" stroke-width="1"/>`;
    g += `<text x="${x}" y="${top + data.length * rowH + 12}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${t.muted}">${v}%</text>`;
  }
  data.forEach((r, i) => {
    const y = top + i * rowH;
    const w = (plotW * r.pct) / 100;
    g += `<text x="${left - 12}" y="${y + barH / 2 + 4}" text-anchor="end" font-family="${FONT}" font-size="12.5" fill="${t.ink}">${esc(r.label)}</text>`;
    g += hbar(left, y, w, barH, 4, t.s1);
    g += `<text x="${left + w + 8}" y="${y + barH / 2 + 4}" font-family="${FONT}" font-size="12.5" fill="${t.ink}"><tspan font-weight="600">−${r.pct}%</tspan><tspan fill="${t.ink2}">  ${k(r.before)} → ${k(r.after)}</tspan></text>`;
  });
  return frame(W, H, t, g, 'Tokens saved per scenario', 'Share of input tokens removed · label shows tokens before → after · run `npm run bench` to reproduce');
}

function sessionChart(s, t) {
  const W = 860, H = 390, left = 70, right = 150, top = 100, bottom = 46;
  const pw = W - left - right, ph = H - top - bottom;
  // "Nice" tick step (1/2/2.5/5 × 10^n) so labels are exact, never rounded.
  const raw = s.without / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw);
  const steps = Math.ceil(s.without / step);
  const max = steps * step;
  const X = (i) => left + (pw * i) / (s.turns - 1);
  const Y = (v) => top + ph - (ph * v) / max;
  let g = '';
  // Legend row (identity never colour-alone: legend + direct end labels)
  g += `<line x1="24" y1="76" x2="40" y2="76" stroke="${t.s2}" stroke-width="2"/><text x="46" y="80" font-family="${FONT}" font-size="12" fill="${t.ink2}">Without TokenArmy</text>`;
  g += `<line x1="180" y1="76" x2="196" y2="76" stroke="${t.s1}" stroke-width="2"/><text x="202" y="80" font-family="${FONT}" font-size="12" fill="${t.ink2}">With TokenArmy</text>`;
  for (let i = 0; i <= steps; i++) {
    const v = (max * i) / steps;
    g += `<line x1="${left}" y1="${Y(v)}" x2="${left + pw}" y2="${Y(v)}" stroke="${i === 0 ? t.axis : t.grid}" stroke-width="1"/>`;
    g += `<text x="${left - 10}" y="${Y(v) + 4}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${t.muted}">${k(v)}</text>`;
  }
  for (const turn of [1, 10, 20, 30, 40]) g += `<text x="${X(turn - 1)}" y="${top + ph + 18}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${t.muted}">${turn}</text>`;
  g += `<text x="${left + pw / 2}" y="${top + ph + 36}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${t.muted}">turn</text>`;
  const line = (arr, color) => `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${arr.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>`;
  g += line(s.seriesWithout, t.s2) + line(s.seriesWith, t.s1);
  const end = s.turns - 1;
  for (const [arr, color, name] of [[s.seriesWithout, t.s2, 'Without'], [s.seriesWith, t.s1, 'With']]) {
    g += `<circle cx="${X(end)}" cy="${Y(arr[end])}" r="4" fill="${color}" stroke="${t.surface}" stroke-width="2"/>`;
    g += `<text x="${X(end) + 10}" y="${Y(arr[end]) + 4}" font-family="${FONT}" font-size="12.5" fill="${t.ink}"><tspan font-weight="600">${k(arr[end])}</tspan><tspan fill="${t.ink2}"> ${name}</tspan></text>`;
  }
  return frame(W, H, t, g, `Cumulative input tokens over a ${s.turns}-turn agent session: −${s.pct}%`, 'Every turn resends the system prompt, CLAUDE.md and all history · model in bench/run.js · prompt caching not applied');
}

function heroCard(results, t) {
  const cmd = results.rows.filter((r) => r.tool === 'hook / run');
  const b = cmd.reduce((a, r) => a + r.before, 0), a = cmd.reduce((x, r) => x + r.after, 0);
  const tiles = [
    [`−${Math.round(((b - a) / b) * 100)}%`, 'command output', `${cmd.length} common dev commands`],
    [`−${results.session.pct}%`, 'per agent session', `${results.session.turns}-turn session model`],
    [`−${results.rows.find((r) => r.id === 'outline').pct}%`, 'file reads', 'tokenarmy outline'],
    [`−${results.rows.find((r) => r.id === 'rag').pct}%`, 'RAG context', 'BM25 + MMR budget pack'],
  ];
  const W = 860, H = 150, tw = (W - 48 - 3 * 12) / 4;
  let g = '';
  tiles.forEach(([v, l, s], i) => {
    const x = 24 + i * (tw + 12);
    g += `<rect x="${x}" y="24" width="${tw}" height="102" rx="10" fill="none" stroke="${t.border}"/>`;
    g += `<text x="${x + 18}" y="70" font-family="${FONT}" font-size="34" font-weight="700" fill="${t.ink}">${esc(v)}</text>`;
    g += `<text x="${x + 18}" y="94" font-family="${FONT}" font-size="13" font-weight="600" fill="${t.ink}">${esc(l)}</text>`;
    g += `<text x="${x + 18}" y="112" font-family="${FONT}" font-size="11.5" fill="${t.ink2}">${esc(s)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="TokenArmy benchmark headline numbers"><title>TokenArmy benchmark headline numbers</title><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.surface}" stroke="${t.border}"/>${g}</svg>\n`;
}

function render(results, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [mode, t] of Object.entries(THEMES)) {
    fs.writeFileSync(path.join(dir, `savings-${mode}.svg`), savingsChart(results.rows, t));
    fs.writeFileSync(path.join(dir, `session-${mode}.svg`), sessionChart(results.session, t));
    fs.writeFileSync(path.join(dir, `hero-${mode}.svg`), heroCard(results, t));
  }
}

module.exports = { render };
