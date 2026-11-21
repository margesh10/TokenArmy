'use strict';
// `tokenarmy ab <config.json>`: controlled A/B benchmark of TokenArmy on a real task.
//
// The same task runs N times with TokenArmy OFF and N times ON, each in a fresh copy of the
// project, interleaved (ABBA) so drift hits both sides equally, after a discarded warm-up pair.
// Ground truth is Claude's own transcript (billed usage, de-duplicated per message), never
// TokenArmy's ledger. A run only counts as a success if your check command passes and, if you
// give one, the final answer matches `expect`: savings bought by blinding the model don't count.
//
// Config (JSON):
// {
//   "name": "my-task",
//   "template": "C:/path/to/project",           // copied fresh for every run (never modified)
//   "exclude": [".git", "node_modules", ".venv"],// not copied
//   "setup": ["sed -i 's/a/b/' src/x.js"],       // optional: run in each copy before the agent
//   "prompt": "Fix the failing test ...",
//   "check": "npm test",                         // exit 0 = task done
//   "expect": "dedupeRuns",                      // optional regex the final answer must match
//   "runs": 5, "warmup": 1, "parallel": true,
//   "model": "claude-opus-5-5", "budget": 2, "allowedTools": "Bash Read Edit Grep Glob"
// }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

function hooksSettings() {
  const node = (f) => `node "${path.join(REPO, 'hooks', f).replace(/\\/g, '/')}"`;
  return {
    hooks: {
      PostToolUse: [{ matcher: 'Bash|PowerShell|Read|Grep', hooks: [{ type: 'command', command: node('claude-posttooluse.js'), timeout: 10 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: node('claude-lifecycle.js'), timeout: 10 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: node('claude-lifecycle.js'), timeout: 10 }] }],
    },
  };
}

// Billed usage from the session transcript, one count per assistant message id.
function billed(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let file = null;
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) file = f;
    }
  } catch {
    /* no projects dir */
  }
  if (!file) return null;
  const byMsg = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e.message;
    if (e.type === 'assistant' && m && m.usage) byMsg.set(m.id || e.uuid, m.usage);
  }
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, messages: byMsg.size };
  for (const u of byMsg.values()) {
    t.input += u.input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.cacheWrite += u.cache_creation_input_tokens || 0;
    t.output += u.output_tokens || 0;
  }
  t.processed = t.input + t.cacheRead + t.cacheWrite;
  return t;
}

const DEFAULT_EXCLUDE = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache'];

function copyProject(src, dest, exclude) {
  const skip = new Set(exclude || DEFAULT_EXCLUDE);
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !skip.has(path.basename(p)) });
}

// Fingerprint of the template (path, size, mtime) so we can prove no run touched the original.
function fingerprint(root, exclude) {
  const skip = new Set([...(exclude || DEFAULT_EXCLUDE), '__pycache__', '.pytest_cache']);
  const out = [];
  const walk = (d) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const st = fs.statSync(p);
          out.push(`${path.relative(root, p)}|${st.size}|${st.mtimeMs}`);
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(root);
  return out.sort();
}

function changedFiles(before, after) {
  const a = new Set(before);
  const b = new Set(after);
  const name = (x) => x.split('|')[0];
  return [...new Set([...before.filter((x) => !b.has(x)), ...after.filter((x) => !a.has(x))].map(name))];
}

// The agent must only ever work in its copy. A prompt that names the real project invites it to edit there.
function guardConfig(cfg, template) {
  const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
  const t = norm(template).replace(/\/$/, '');
  if (t && norm(cfg.prompt).includes(t)) {
    throw new Error(
      `the prompt mentions the template path (${template}). The agent may edit the original project there.\n` +
        `Refer to files relatively, and reach tools through "pathPrepend"/"env" in the config instead (e.g. "pathPrepend": ["${template.replace(/\\/g, '/')}/.venv/Scripts"] and say \`python -m pytest\`).`
    );
  }
}

function runOne(cfg, side, dir, settingsFile) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--settings', `"${settingsFile}"`, '--max-budget-usd', String(cfg.budget || 2), '--permission-mode', 'acceptEdits', '--allowedTools', `"${cfg.allowedTools || 'Bash Read Edit Grep Glob'}"`];
    if (cfg.model) args.push('--model', cfg.model);
    const env = { ...process.env, ...(cfg.env || {}), TOKENARMY_HOME: path.join(dir, '..', path.basename(dir) + '.home'), TOKENARMY_OFF: side === 'off' ? '1' : '' };
    if (cfg.pathPrepend && cfg.pathPrepend.length) {
      const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      env[key] = [...cfg.pathPrepend.map((p) => path.resolve(p)), env[key]].join(path.delimiter);
    }
    const t0 = Date.now();
    const p = spawn('claude', args, { cwd: dir, env, shell: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.stdin.end(cfg.prompt);
    p.on('close', (code) => {
      let r = {};
      try {
        r = JSON.parse(out);
      } catch {
        r = { is_error: true, result: (out || err).slice(0, 500) };
      }
      const check = cfg.check ? spawnSync(cfg.check, { cwd: dir, shell: true, encoding: 'utf8', env: { ...env, TOKENARMY_OFF: '' } }) : { status: 0 };
      const expectOk = cfg.expect ? new RegExp(cfg.expect, 'i').test(String(r.result || '')) : true;
      const ledger = (() => {
        try {
          return fs.readFileSync(path.join(env.TOKENARMY_HOME, 'gain.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        } catch {
          return [];
        }
      })();
      resolve({
        side,
        dir,
        exit: code,
        ok: !r.is_error && check.status === 0 && expectOk,
        checkPassed: check.status === 0,
        expectOk,
        cost: r.total_cost_usd ?? null,
        turns: r.num_turns ?? null,
        secs: Math.round((Date.now() - t0) / 1000),
        billed: r.session_id ? billed(r.session_id) : null,
        compressions: ledger.filter((e) => e.before > 0).length,
        saved: ledger.reduce((a, e) => a + ((e.before || 0) - (e.after || 0)), 0),
        result: String(r.result || '').slice(0, 300),
      });
    });
  });
}

const median = (a) => {
  const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const range = (a) => {
  const s = a.filter((x) => typeof x === 'number');
  return s.length ? [Math.min(...s), Math.max(...s)] : null;
};

function summarize(results) {
  const metrics = {
    'success': (r) => (r.ok ? 1 : 0),
    'cost $': (r) => r.cost,
    'turns': (r) => r.turns,
    'tokens processed': (r) => r.billed && r.billed.processed,
    'output tokens': (r) => r.billed && r.billed.output,
    'TokenArmy compressions': (r) => r.compressions,
  };
  const rows = [];
  for (const [name, f] of Object.entries(metrics)) {
    const off = results.filter((r) => r.side === 'off').map(f);
    const on = results.filter((r) => r.side === 'on').map(f);
    if (name === 'success') {
      rows.push({ metric: name, off: `${off.reduce((a, b) => a + b, 0)}/${off.length}`, on: `${on.reduce((a, b) => a + b, 0)}/${on.length}`, change: '', verdict: '' });
      continue;
    }
    const mo = median(off);
    const mn = median(on);
    const ro = range(off);
    const rn = range(on);
    const change = mo ? `${mn >= mo ? '+' : ''}${Math.round(((mn - mo) / mo) * 100)}%` : '';
    // Overlapping ranges = the difference is within run-to-run noise at this sample size.
    const verdict = ro && rn && name !== 'TokenArmy compressions' ? (rn[1] < ro[0] ? 'lower' : rn[0] > ro[1] ? 'higher' : 'within noise') : '';
    const fmt = (v) => (v == null ? '–' : name === 'cost $' ? v.toFixed(3) : Math.round(v).toLocaleString());
    rows.push({ metric: name, off: `${fmt(mo)} (${ro ? ro.map(fmt).join('–') : '–'})`, on: `${fmt(mn)} (${rn ? rn.map(fmt).join('–') : '–'})`, change, verdict });
  }
  return rows;
}

function toMarkdown(cfg, rows, results) {
  const lines = [`## A/B: ${cfg.name || 'task'}`, '', `${results.filter((r) => r.side === 'off').length} runs per side, median (min–max). Billed tokens from Claude's transcripts.`, '', '| Metric | TokenArmy off | TokenArmy on | Change | Verdict |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.metric} | ${r.off} | ${r.on} | ${r.change} | ${r.verdict} |`);
  return lines.join('\n');
}

async function ab(cfgFile, { out } = {}) {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  if (!cfg.template || !cfg.prompt) throw new Error('config needs "template" and "prompt"');
  const template = path.resolve(cfg.template);
  guardConfig(cfg, template);
  const original = fingerprint(template, cfg.exclude);
  const runs = cfg.runs || 3;
  const warmup = cfg.warmup ?? 1;
  const base = out || path.join(os.tmpdir(), `tokenarmy-ab-${Date.now()}`);
  fs.mkdirSync(base, { recursive: true });
  const settingsFile = path.join(base, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(hooksSettings(), null, 2));
  const prep = (label) => {
    const dir = path.join(base, label);
    copyProject(path.resolve(cfg.template), dir, cfg.exclude);
    for (const s of cfg.setup || []) {
      const r = spawnSync(s, { cwd: dir, shell: true, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`setup failed in ${dir}: ${s}\n${r.stderr}`);
    }
    return dir;
  };
  const results = [];
  const total = warmup + runs;
  for (let i = 0; i < total; i++) {
    const order = i % 2 ? ['on', 'off'] : ['off', 'on']; // ABBA
    const tag = i < warmup ? `warmup${i + 1}` : `run${i - warmup + 1}`;
    const dirs = Object.fromEntries(order.map((s) => [s, prep(`${tag}-${s}`)]));
    process.stderr.write(`[ab] ${tag}: ${order.join(' + ')}${cfg.parallel === false ? ' (sequential)' : ''}…\n`);
    let pair;
    if (cfg.parallel === false) {
      pair = [];
      for (const s of order) pair.push(await runOne(cfg, s, dirs[s], settingsFile));
    } else pair = await Promise.all(order.map((s) => runOne(cfg, s, dirs[s], settingsFile)));
    for (const r of pair) process.stderr.write(`[ab]   ${r.side}: ${r.ok ? 'ok' : 'FAILED'} · $${(r.cost || 0).toFixed(3)} · ${r.turns} turns · ${r.compressions} compressions\n`);
    const touched = changedFiles(original, fingerprint(template, cfg.exclude));
    if (touched.length) {
      throw new Error(`STOPPED: a run modified the ORIGINAL project at ${template}:\n  ${touched.join('\n  ')}\nRestore those files (from version control or a backup) and check the prompt for paths into the project.`);
    }
    // Rate/usage limits make a run end with no work done; keep them out of the data.
    const limited = pair.filter((r) => /usage limit|hit your .*limit|rate limit/i.test(r.result));
    if (i >= warmup && !limited.length) results.push(...pair);
    // Save as we go, so an interrupted benchmark still leaves usable data.
    fs.writeFileSync(path.join(base, 'results.partial.json'), JSON.stringify({ config: cfg, results }, null, 2));
    if (limited.length) throw new Error(`STOPPED: a run hit a usage limit ("${limited[0].result.slice(0, 80)}"). This pair was discarded. Results so far: ${path.join(base, 'results.partial.json')}`);
  }
  const rows = summarize(results);
  const md = toMarkdown(cfg, rows, results);
  fs.writeFileSync(path.join(base, 'results.json'), JSON.stringify({ config: cfg, results, summary: rows }, null, 2));
  fs.writeFileSync(path.join(base, 'results.md'), md + '\n');
  return { md, dir: base, results, rows };
}

module.exports = { ab, billed, summarize, toMarkdown, hooksSettings };
