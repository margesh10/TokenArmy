'use strict';
// Environment facts: one-line lessons about how commands are spelled in THIS repository,
// learned from the agent's own failures and handed back at the start of later sessions.
//
// Sessions keep rediscovering the same thing by failing at it: `pytest` is not on PATH but
// `python -m pytest` works, `tsc` is missing but `npx tsc` runs. Each rediscovery costs a
// failed call, its error output, and a turn. The idea comes from TokenEconomizer's
// "micro-skills" (FormRepair): a failing form followed in the same session by a working form
// of the same tool becomes a candidate fact.
//
//   candidate  seen once: form A failed to resolve, then form B of the same tool ran
//   active     confirmed in MIN_SESSIONS different sessions; injected at SessionStart
//   retired    the bare form A resolved fine in CONTRA_STREAK sessions in a row (the
//              environment changed); a later failure of A resets the streak
//
// Rules that keep a fact honest:
//   - only "could not resolve the command" errors count (command not found, not recognized,
//     No module named <tool>); a test that fails is not a spelling problem
//   - every string in a fact is copied from a command the agent ran here; nothing is invented
//   - a fact states what fails and what works. It never says "skip", "don't verify" or "done"
//   - the injected block is capped (MAX_FACTS lines, ~MAX_TOKENS tokens)
// State lives in ~/.tokenarmy/facts/<repo-hash>.json. Local only. Off: TOKENARMY_FACTS=0.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stats = require('./stats');
const session = require('./session');

const DIR = path.join(path.dirname(stats.FILE), 'facts');
const MIN_SESSIONS = +(process.env.TOKENARMY_FACTS_MIN_SESSIONS || 2);
const CONTRA_STREAK = 2;
const MAX_FACTS = 4;
const MAX_TOKENS = 150;
const HEADER = '# Environment facts learned from earlier sessions in this repository (TokenArmy)';

// "Could not resolve the command" in bash, zsh, sh, PowerShell, cmd.exe, python -m, npx.
const UNRESOLVED = [
  /(?:^|[\s:])([\w.+\/\\-]+): (?:command not found|not found)\s*$/m, //   bash: pytest: command not found / sh: 1: tsc: not found
  /zsh: command not found: ([\w.+\/\\-]+)/,
  /The term '([^']+)' is not recognized as (?:the )?name of a cmdlet/, // PowerShell
  /'([^']+)' is not recognized as an internal or external command/, // cmd.exe
  /No module named ['"]?([\w.]+)['"]?\s*$/m, // python -m X
  /could not determine executable to run/, // npx
];
// Commands that mention a tool without running it.
const NOT_A_RUN = /^(which|where|where\.exe|type|command|get-command|gcm|hash|echo|cat|ls|dir|pip3?|pipx|npm|pnpm|yarn|bun|apt(-get)?|brew|choco|winget|scoop|cargo|go|conda|uv|poetry)$/i;
const RUNNER_ARG = /^(run|exec|x|dlx)$/i; // npm exec tsc, pnpm dlx, uv run pytest, poetry run pytest, bun x

const repoKey = (cwd) => crypto.createHash('sha1').update(path.resolve(String(cwd || '.')).toLowerCase()).digest('hex').slice(0, 16);
const file = (cwd) => path.join(DIR, `${repoKey(cwd)}.json`);

function load(cwd) {
  try {
    return JSON.parse(fs.readFileSync(file(cwd), 'utf8'));
  } catch {
    return { cwd: path.resolve(String(cwd || '.')), facts: {} };
  }
}

function save(cwd, db) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file(cwd), JSON.stringify(db, null, 1));
  } catch {
    /* best-effort */
  }
}

const base = (t) => String(t).replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();

// "cd x && FOO=1 .venv/bin/python -m pytest -q tests/" -> [{ tokens }, ...] one per segment.
function segments(cmd) {
  return String(cmd || '')
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim().replace(/^(\w+=\S*\s+)+/, ''))
    .filter((s) => s && !/^(cd|Set-Location|pushd|export|set)\b/i.test(s))
    .map((s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, '')));
}

// The form of `tool` inside a command: everything typed up to and including the tool
// ("python -m pytest", "npx tsc", ".venv/Scripts/pytest"), or null if the tool is not run.
function formOf(cmd, tool) {
  for (const toks of segments(cmd)) {
    for (let i = 0; i < toks.length && i < 4; i++) {
      if (base(toks[i]) !== tool) continue;
      const head = base(toks[0]);
      if (i === 0) return toks[0];
      const prev = toks[i - 1];
      // python -m pytest / py -m pytest
      if (prev === '-m' && /^(python\d?(\.\d+)?|py|python3)$/.test(base(toks[i - 2] || ''))) return toks.slice(0, i + 1).join(' ');
      // npx tsc / bunx / pnpm exec tsc / uv run pytest / poetry run pytest
      if (/^(npx|bunx|pnpx)$/.test(head) || RUNNER_ARG.test(prev)) return toks.slice(0, i + 1).join(' ');
      if (NOT_A_RUN.test(head)) return null;
    }
  }
  return null;
}

// The first tool a command failed to resolve, and the form it was typed in.
function unresolved(cmd, text) {
  const out = String(text || '');
  for (const re of UNRESOLVED) {
    const m = out.match(re);
    if (!m) continue;
    let tool = m[1] ? base(m[1]) : null;
    if (!tool) {
      // npx gave no name: use the tool after npx.
      const s = segments(cmd).find((t) => /^(npx|bunx|pnpx)$/.test(base(t[0] || '')));
      tool = s && s[1] ? base(s[1]) : null;
    }
    if (!tool) continue;
    const form = formOf(cmd, tool);
    if (!form) continue; // the error names something the command did not run directly
    return { tool, form, error: /No module named/.test(m[0]) ? 'No module named' : /recognized/.test(m[0]) ? 'not recognized' : /executable/.test(m[0]) ? 'npx could not run it' : 'command not found' };
  }
  return null;
}

// Fold one shell call into the repo's facts. Returns the db when something changed.
function observe(evt, cmd, text) {
  if (process.env.TOKENARMY_FACTS === '0' || !evt || !evt.cwd || !evt.session_id || !cmd) return null;
  const sid = evt.session_id;
  const pend = session.load(sid, 'facts-pending.json', {});
  const db = load(evt.cwd);
  let changed = false;
  const miss = unresolved(cmd, text);

  if (miss) {
    pend[miss.tool] = { form: miss.form, error: miss.error };
    session.save(sid, 'facts-pending.json', pend);
  }

  for (const f of Object.values(db.facts)) {
    const typed = formOf(cmd, f.tool);
    if (!typed) continue;
    if (typed === f.fail) {
      if (miss && miss.tool === f.tool) {
        // The bare form failed again: evidence for the fact, and the contradiction streak resets.
        if (!f.sessions.includes(sid)) f.sessions.push(sid);
        f.contra = 0;
        f.contraSessions = [];
        if (f.state === 'retired') f.state = f.sessions.length >= MIN_SESSIONS ? 'active' : 'candidate';
      } else if (!miss && !(f.contraSessions || []).includes(sid)) {
        // The bare form resolved: the environment may have changed.
        f.contraSessions = [...(f.contraSessions || []), sid].slice(-CONTRA_STREAK);
        f.contra = (f.contra || 0) + 1;
        if (f.contra >= CONTRA_STREAK) f.state = 'retired';
      }
      changed = true;
    } else if (typed === f.works && !miss && !f.sessions.includes(sid)) {
      // The working form ran (perhaps because the fact told the agent to): keep it alive.
      f.sessions.push(sid);
      if (f.state === 'candidate' && f.sessions.length >= MIN_SESSIONS) f.state = 'active';
      changed = true;
    }
  }

  // Repair: an earlier form of this tool failed to resolve in this session, a different one ran.
  if (!miss) {
    for (const [tool, p] of Object.entries(pend)) {
      const typed = formOf(cmd, tool);
      if (!typed) continue;
      if (typed === p.form) {
        // The failing form itself works now (something got installed): nothing to learn.
        delete pend[tool];
        session.save(sid, 'facts-pending.json', pend);
        continue;
      }
      const id = `${p.form} => ${typed}`;
      const f = db.facts[id] || (db.facts[id] = { tool, fail: p.form, works: typed, error: p.error, sessions: [], contra: 0, state: 'candidate', first: new Date().toISOString() });
      if (!f.sessions.includes(sid)) f.sessions.push(sid);
      f.sessions = f.sessions.slice(-20);
      f.last = new Date().toISOString();
      if (f.state !== 'retired' && f.sessions.length >= MIN_SESSIONS) f.state = 'active';
      delete pend[tool];
      session.save(sid, 'facts-pending.json', pend);
      changed = true;
    }
  }
  if (changed) save(evt.cwd, db);
  return changed ? db : null;
}

const claim = (f) => `\`${f.fail}\` fails here (${f.error}); \`${f.works}\` works.`;
const ADVICE = /\b(skip|no need|don'?t|do not|stop|done|complete[d]?|finish(ed)?|verify|verification)\b/i;

// The active facts as "- …" lines (no header).
function lines(cwd) {
  const block = render(cwd);
  return block ? block.split('\n').slice(1) : [];
}

// The block for SessionStart, or '' when nothing is active.
function render(cwd) {
  if (process.env.TOKENARMY_FACTS === '0' || !cwd) return '';
  const db = load(cwd);
  const active = Object.values(db.facts)
    .filter((f) => f.state === 'active' && !ADVICE.test(claim(f)))
    .sort((a, b) => b.sessions.length - a.sessions.length || String(b.last).localeCompare(String(a.last)));
  // One working form per failing form: the best-confirmed one.
  const seen = new Set();
  const lines = [];
  for (const f of active) {
    if (seen.has(f.fail) || lines.length >= MAX_FACTS) continue;
    const next = [HEADER, ...lines, `- ${claim(f)}`].join('\n');
    if (next.length > MAX_TOKENS * 4) continue;
    seen.add(f.fail);
    lines.push(`- ${claim(f)}`);
  }
  return lines.length ? [HEADER, ...lines].join('\n') : '';
}

function list(cwd) {
  return Object.values(load(cwd).facts).sort((a, b) => (a.state === b.state ? b.sessions.length - a.sessions.length : a.state === 'active' ? -1 : 1));
}

function clear(cwd) {
  try {
    fs.unlinkSync(file(cwd));
    return true;
  } catch {
    return false;
  }
}

module.exports = { observe, render, lines, list, clear, unresolved, formOf, claim, file, repoKey, MIN_SESSIONS };
