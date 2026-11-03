'use strict';
// Project brief: what earlier sessions in this repository already found out, stated in a few
// lines at session start, so a new session does not spend turns rediscovering it.
//
// After Hindsight's "mental models" (an agent boots with a page of settled knowledge instead of
// rediscovering it every session) and its "observations" (every belief carries a proof count),
// but local and LLM-free: every line is computed from what the agent actually ran and read here,
// and every line carries the number of sessions behind it.
//
//   Commands that worked   test/build/lint/typecheck commands that ran clean in 2+ sessions
//   Often read             files read in 3+ sessions
//   Still failing          the same failure in 3+ sessions, and the latest run of that command
//                          failed with it too (a failure that was fixed drops out by itself)
//
// Capped at ~MAX_TOKENS. State: ~/.tokenarmy/brief/<repo-hash>.json. Off: TOKENARMY_BRIEF=0.
const fs = require('fs');
const path = require('path');
const stats = require('./stats');
const { detectFilter } = require('./filters');
const { repoKey } = require('./facts');

const DIR = path.join(path.dirname(stats.FILE), 'brief');
const MAX_TOKENS = 220;
const KEEP_SESSIONS = 20;
const MIN_CMD_SESSIONS = 2;
const MIN_FILE_SESSIONS = 3;
const MIN_FAIL_SESSIONS = 3;
const HEADER = '# Project brief from earlier sessions in this repository (TokenArmy; numbers = sessions)';

// Verification commands: the ones a new session would otherwise have to work out.
const VERIFY = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|type-check|check|tsc|e2e)\b|\b(make|just|task)\s+(test|check|lint|build)\b|\b(tox|nox|ctest)\b/;
const VERIFY_FILTERS = new Set(['tests', 'diagnostics', 'build']);
// A failure in the output (warnings don't count; "0 failed" doesn't count).
const FAILED = /\b(error|errors|fail(ed|ure|ures|ing)?|fatal|panic(ked)?|traceback|exception|not recognized|command not found)\b/i;
const NOT_FAILED = /\b(0 (failed|failures|errors?)|no errors?|failures: 0|errors: 0|0 problems)\b/i;

const file = (cwd) => path.join(DIR, `${repoKey(cwd)}.json`);

function load(cwd) {
  try {
    return JSON.parse(fs.readFileSync(file(cwd), 'utf8'));
  } catch {
    return { cwd: path.resolve(String(cwd)), commands: {}, files: {}, failures: {}, last: {} };
  }
}

function save(cwd, db) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file(cwd), JSON.stringify(db));
  } catch {
    /* best-effort */
  }
}

const off = () => process.env.TOKENARMY_BRIEF === '0' || process.env.TOKENARMY_OFF === '1';
const addSession = (list, sid) => (list.includes(sid) ? list : [...list, sid].slice(-KEEP_SESSIONS));

// "cd web && npm test -- --silent 2>&1 | tail -20" -> "npm test -- --silent"
function normalize(cmd) {
  const parts = String(cmd || '')
    .split(/&&|;/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(cd|Set-Location|pushd|export|set)\b/i.test(s));
  return (parts[0] || '')
    .split(/\s\|\s?|\s2>&1|\s>\s?\S+/)[0]
    .replace(/#.*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function isVerify(cmd) {
  const rule = detectFilter(cmd);
  return VERIFY.test(cmd) || (rule && VERIFY_FILTERS.has(rule.name));
}

function failureLine(text) {
  return String(text || '')
    .split('\n')
    .find((l) => FAILED.test(l) && !NOT_FAILED.test(l));
}

function observeCommand(evt, cmd, text) {
  if (off() || !evt || !evt.cwd || !evt.session_id) return;
  const norm = normalize(cmd);
  if (!norm || !isVerify(norm)) return;
  const db = load(evt.cwd);
  const sid = evt.session_id;
  const bad = failureLine(text);
  const fam = norm.split(' ').slice(0, 2).join(' ');
  if (!bad) {
    const c = db.commands[norm] || (db.commands[norm] = { sessions: [] });
    c.sessions = addSession(c.sessions, sid);
    c.at = Date.now();
    db.last[fam] = null;
  } else {
    const sig = bad.trim().replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 140);
    const key = `${fam} :: ${sig}`;
    const f = db.failures[key] || (db.failures[key] = { cmd: fam, line: bad.trim().slice(0, 140), sessions: [] });
    f.sessions = addSession(f.sessions, sid);
    db.last[fam] = key;
  }
  save(evt.cwd, db);
}

function observeRead(evt, filePath) {
  if (off() || !evt || !evt.cwd || !evt.session_id || !filePath) return;
  const rel = path.relative(evt.cwd, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return; // outside this repository
  const key = rel.replace(/\\/g, '/');
  const db = load(evt.cwd);
  const f = db.files[key] || (db.files[key] = { sessions: [] });
  if (f.sessions.includes(evt.session_id)) return;
  f.sessions = addSession(f.sessions, evt.session_id);
  save(evt.cwd, db);
}

// The brief for SessionStart ('' when there is not enough evidence yet). `extra` lines (the
// environment facts) are appended under the same header.
function render(cwd, extra = []) {
  if (off() || !cwd) return extra.length ? [HEADER, ...extra].join('\n') : '';
  const db = load(cwd);
  const lines = [];
  const top = (obj, min, n) =>
    Object.entries(obj)
      .filter(([, v]) => v.sessions.length >= min)
      .sort((a, b) => b[1].sessions.length - a[1].sessions.length || (b[1].at || 0) - (a[1].at || 0) || a[0].localeCompare(b[0]))
      .slice(0, n);
  const cmds = top(db.commands, MIN_CMD_SESSIONS, 4);
  if (cmds.length) lines.push(`- Commands that ran clean here: ${cmds.map(([c, v]) => `\`${c}\` (${v.sessions.length})`).join(', ')}`);
  const files = top(db.files, MIN_FILE_SESSIONS, 6);
  if (files.length) lines.push(`- Files read in most sessions: ${files.map(([f, v]) => `${f} (${v.sessions.length})`).join(', ')}`);
  const live = new Set(Object.values(db.last).filter(Boolean));
  for (const [key, f] of top(db.failures, MIN_FAIL_SESSIONS, 4).filter(([k]) => live.has(k)).slice(0, 2)) {
    lines.push(`- Still failing at the end of earlier sessions: \`${f.cmd}\`: "${f.line}" (${f.sessions.length})`);
  }
  const all = [...lines, ...extra];
  if (!all.length) return '';
  const out = [HEADER];
  for (const l of all) {
    if ([...out, l].join('\n').length > MAX_TOKENS * 4) break;
    out.push(l);
  }
  return out.length > 1 ? out.join('\n') : '';
}

function clear(cwd) {
  try {
    fs.unlinkSync(file(cwd));
    return true;
  } catch {
    return false;
  }
}

module.exports = { observeCommand, observeRead, render, clear, normalize, isVerify, file };
