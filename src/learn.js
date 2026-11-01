'use strict';
// Local learning loop.
//  1. User/learned filters: ~/.tokenarmy/filters.json and <project>/.tokenarmy/filters.json
//       { "rules": [{ "name", "cmd": "<regex>", "drop": ["<regex>", ...] }], "bypass": ["<regex>", ...] }
//     A rule drops matching noise lines; SIGNAL lines (errors, failures…) are never dropped.
//     "bypass" commands are never compressed beyond lossless cleanup.
//  2. Expand tracking: when the agent opens a raw log TokenArmy saved, that compression hid
//     something it needed. Families with a high expand rate get auto-bypassed.
//  3. `tokenarmy learn` mines raw logs for lines that repeat across runs and proposes drop rules.
const fs = require('fs');
const path = require('path');
const stats = require('./stats');
const { SIGNAL } = require('./squeeze-signal');

const HOME = path.dirname(stats.FILE);
const RAW_DIR = path.join(HOME, 'raw');
const USER_FILTERS = path.join(HOME, 'filters.json');

// "cd x && C:/py/python.exe -m pytest -q" -> "python -m pytest"; "git log --oneline" -> "git log"
function family(cmd) {
  let s = String(cmd || '').split(/&&|;|\|\|/).map((p) => p.trim()).filter((p) => !/^(cd|Set-Location|export|set)\b/i.test(p))[0] || '';
  s = s.split('|')[0].trim().replace(/^(\w+=\S*\s+)+/, '');
  const toks = s.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (!toks.length) return '';
  const base = (t) => t.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  const out = [base(toks[0])];
  if (toks[1] === '-m' && toks[2]) out.push('-m', toks[2]);
  else if (toks[1] && /^[a-z][\w:-]*$/i.test(toks[1])) out.push(toks[1]);
  return out.join(' ');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadFilters(cwd) {
  const merged = { rules: [], bypass: [] };
  for (const f of [USER_FILTERS, cwd && path.join(cwd, '.tokenarmy', 'filters.json')]) {
    const j = f && readJson(f);
    if (!j) continue;
    if (Array.isArray(j.rules)) merged.rules.push(...j.rules);
    if (Array.isArray(j.bypass)) merged.bypass.push(...j.bypass);
  }
  return merged;
}

const re = (s) => {
  try {
    return new RegExp(s, 'i');
  } catch {
    return null;
  }
};

function applyUserRules(command, output, filters) {
  let out = output;
  let applied = 0;
  for (const r of filters.rules || []) {
    const cm = re(r.cmd || '.');
    if (!cm || !cm.test(command)) continue;
    const drops = (r.drop || []).map(re).filter(Boolean);
    if (!drops.length) continue;
    const lines = out.split('\n');
    const kept = lines.filter((l) => SIGNAL.test(l) || !drops.some((d) => d.test(l)));
    if (kept.length < lines.length) {
      applied++;
      const n = lines.length - kept.length;
      kept.push(`[tokenarmy] ${n} line${n === 1 ? '' : 's'} dropped by filter "${r.name || r.cmd}"`);
      out = kept.join('\n');
    }
  }
  return { output: out, applied };
}

function isBypassed(command, filters) {
  return (filters.bypass || []).some((b) => {
    const r = re(b);
    return r && r.test(command);
  });
}

// Families whose compressed output the agent keeps opening in full.
function autoBypassed(rows) {
  const fam = {};
  for (const r of rows || []) {
    if (!r.family) continue;
    const f = (fam[r.family] = fam[r.family] || { compressed: 0, expanded: 0 });
    if (r.kind === 'expand') f.expanded++;
    else if (r.kind && r.kind.startsWith('hook:')) f.compressed++;
  }
  const out = new Set();
  for (const [k, v] of Object.entries(fam)) if (v.expanded >= 2 && v.expanded >= v.compressed * 0.5) out.add(k);
  return { families: fam, bypass: out };
}

function rawLogCommand(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(400);
    const n = fs.readSync(fd, buf, 0, 400, 0);
    fs.closeSync(fd);
    const first = buf.toString('utf8', 0, n).split('\n')[0];
    return first.startsWith('$ ') ? first.slice(2) : null;
  } catch {
    return null;
  }
}

// Does this tool call open one of our raw logs? Returns the original command if so.
function expandTarget(toolName, toolInput) {
  const raw = RAW_DIR.replace(/\\/g, '/').toLowerCase();
  const cand = [];
  if (toolName === 'Read' && toolInput && toolInput.file_path) cand.push(toolInput.file_path);
  if ((toolName === 'Bash' || toolName === 'PowerShell') && toolInput && toolInput.command) cand.push(...(toolInput.command.match(/[^\s"'`]+\.log/g) || []));
  for (const c of cand) {
    const p = c.replace(/\\/g, '/').toLowerCase();
    if (p.includes(raw) || /\.tokenarmy\/raw\//.test(p)) return rawLogCommand(c) || '?';
  }
  return null;
}

// Mine raw logs: per family, line shapes present in >= minLogs logs, never signal, at least 3 per log.
function mine({ minLogs = 3 } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.log')).map((f) => path.join(RAW_DIR, f));
  } catch {
    return [];
  }
  const byFam = {};
  for (const f of files.slice(-500)) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const cmd = rawLogCommand(f);
    if (!cmd) continue;
    const fam = family(cmd);
    const body = text.split('\n--- stdout ---\n')[1] || '';
    const counts = {};
    for (const l of body.split('\n')) {
      if (!l.trim() || SIGNAL.test(l)) continue;
      const shape = l.trim().replace(/\d+(\.\d+)?/g, '#').replace(/[0-9a-f]{7,}/gi, 'H').slice(0, 120);
      counts[shape] = (counts[shape] || 0) + 1;
    }
    const F = (byFam[fam] = byFam[fam] || { logs: 0, shapes: {} });
    F.logs++;
    for (const [s, c] of Object.entries(counts)) {
      if (c < 3) continue;
      const S = (F.shapes[s] = F.shapes[s] || { logs: 0, lines: 0 });
      S.logs++;
      S.lines += c;
    }
  }
  const proposals = [];
  for (const [fam, F] of Object.entries(byFam)) {
    if (F.logs < minLogs) continue;
    const top = Object.entries(F.shapes)
      .filter(([, s]) => s.logs >= minLogs)
      .sort((a, b) => b[1].lines - a[1].lines)
      .slice(0, 5);
    if (!top.length) continue;
    const esc = (s) => '^\\s*' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/#/g, '\\d+(?:\\.\\d+)?').replace(/H/g, '[0-9a-f]{7,}') + '\\s*$';
    proposals.push({
      name: `learned:${fam}`,
      cmd: '\\b' + fam.split(' ').map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+(?:\\S+\\s+)*?'),
      drop: top.map(([s]) => esc(s)),
      evidence: { logs: F.logs, lines: top.reduce((a, [, s]) => a + s.lines, 0), examples: top.map(([s]) => s) },
    });
  }
  return proposals;
}

function writeRules(proposals) {
  const cur = readJson(USER_FILTERS) || { rules: [], bypass: [] };
  cur.rules = cur.rules || [];
  for (const p of proposals) {
    const { evidence, ...rule } = p;
    const i = cur.rules.findIndex((r) => r.name === rule.name);
    if (i >= 0) cur.rules[i] = rule;
    else cur.rules.push(rule);
  }
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(USER_FILTERS, JSON.stringify(cur, null, 2) + '\n');
  return USER_FILTERS;
}

module.exports = { family, loadFilters, applyUserRules, isBypassed, autoBypassed, expandTarget, mine, writeRules, RAW_DIR, USER_FILTERS };
