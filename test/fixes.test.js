'use strict';
// Regression tests for the review fixes: loop-guard false positives, JSON only for API output,
// ledger rotation, per-project expiring auto-bypass, re-read note misses, retention.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ta-fx-'));
function hook(evt, home, env = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'claude-posttooluse.js')], { input: JSON.stringify(evt), encoding: 'utf8', env: { ...process.env, TOKENARMY_OFF: '', TOKENARMY_HOME: home, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
// Load src modules against a given TOKENARMY_HOME (they read it at require time).
function inHome(home, code) {
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TOKENARMY_HOME: home } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const bash = (command, stdout, cwd = '/proj/a', session = 's1') => ({ session_id: session, cwd, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false } });
const stdoutOf = (o) => o && o.hookSpecificOutput.updatedToolOutput.stdout;

// ---------------------------------------------------------------- loop guard
test('loop guard ignores warnings and deprecations on successful runs', () => {
  const home = fresh();
  const ok = 'npm WARN deprecated inflight@1.0.6: This module is not supported\nadded 312 packages in 4s';
  for (let i = 0; i < 6; i++) {
    const o = hook(bash('npm install', ok), home);
    assert.ok(!o || !/failed \d+ times/.test(stdoutOf(o)), `run ${i + 1}: no loop note for a warning`);
  }
  const tsc = 'Found 0 errors. Watching for file changes.';
  for (let i = 0; i < 3; i++) assert.strictEqual(hook(bash('tsc', tsc), home), null);
});

test('loop guard still catches a real repeated failure, including non-zero exit codes', () => {
  const home = fresh();
  const fail = bash('make build', 'gcc -o app main.c\nmake: *** [build] Exit code 2');
  hook(fail, home);
  hook(fail, home);
  assert.match(stdoutOf(hook(fail, home)), /has failed 3 times in a row/);
});

// ---------------------------------------------------------------- JSON scope
const bigJson = JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item number ${i} with a fairly long name`, ok: true })) }, null, 2);

test('JSON is reshaped for API/CLI responses only, never for a file being printed', () => {
  const home = fresh();
  for (const cmd of ['cat data.json', 'type data.json', 'Get-Content data.json', 'head -c 99999 data.json', 'node print-config.js']) {
    const o = hook(bash(cmd, bigJson), home);
    assert.ok(!o || !/\[60 items\]/.test(stdoutOf(o)), `${cmd}: not reshaped`);
  }
  for (const cmd of ['curl -s https://api.example.com/items', 'gh api repos/o/r/issues', 'kubectl get pods -o json', 'aws ec2 describe-instances --output json', 'gh pr list --json number,title']) {
    assert.match(stdoutOf(hook(bash(cmd, bigJson), home)), /\[60 items\]/, `${cmd}: reshaped`);
  }
});

// ---------------------------------------------------------------- ledger rotation
test('ledger rotates past its size limit; gain stays all-time, sessions stay exact', () => {
  const home = fresh();
  const day = 864e5;
  const old = new Date(Date.now() - 3 * day).toISOString();
  const rows = [];
  for (let i = 0; i < 3000; i++) rows.push({ at: old, kind: 'hook:bash', family: 'npm test', proj: '/proj/a', session: 'old', cmd: 'npm test', before: 1000, after: 100 });
  for (let i = 0; i < 3; i++) rows.push({ at: old, kind: 'expand', family: 'npm test', proj: '/proj/a', session: 'old', before: 0, after: 0 });
  fs.writeFileSync(path.join(home, 'gain.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // ~3,000 rows is ~450 KB, under the 1 MB default; force a 50 KB limit to trigger rotation.
  const forced = spawnSync(process.execPath, ['-e', `
    const s = require('./src/stats');
    s.record({ kind: 'hook:bash', family: 'git log', proj: '/proj/a', session: 'now', before: 500, after: 50 });
    const l = require('./src/learn');
    console.log(JSON.stringify({ live: s.readRows().length, all: s.summary(), sess: s.summary({ session: 'now' }), bypass: [...l.autoBypassed(s.readRows(), { project: '/proj/a', archive: s.readArchive(), now: Date.now() }).bypass] }));`], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TOKENARMY_HOME: home, TOKENARMY_LEDGER_MAX_KB: '50' } });
  assert.strictEqual(forced.status, 0, forced.stderr);
  const f = JSON.parse(forced.stdout);
  assert.ok(f.live <= 3, `old rows moved out of the live file (live=${f.live})`);
  assert.strictEqual(f.all.events, 3001, 'all-time totals keep archived rows');
  assert.strictEqual(f.all.saved, 3000 * 900 + 450);
  assert.strictEqual(f.all.expands, 3);
  assert.strictEqual(f.sess.events, 1, 'session totals come from live rows only');
  assert.ok(fs.existsSync(path.join(home, 'gain-archive.json')));
  assert.deepStrictEqual(f.bypass, [], 'old expands (3 of 3000) do not bypass');
});

// ---------------------------------------------------------------- auto-bypass scope + expiry
test('auto-bypass is per project and expires', () => {
  const { autoBypassed } = require('../src/learn');
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (daysAgo) => new Date(now - daysAgo * 864e5).toISOString();
  const rows = [
    { at: at(1), kind: 'hook:bash', family: 'npm test', proj: '/proj/a' },
    { at: at(1), kind: 'expand', family: 'npm test', proj: '/proj/a' },
    { at: at(1), kind: 'expand', family: 'npm test', proj: '/proj/a' },
  ];
  assert.ok(autoBypassed(rows, { project: '/proj/a', now }).bypass.has('npm test'));
  assert.ok(!autoBypassed(rows, { project: '/proj/b', now }).bypass.has('npm test'), 'other project unaffected');
  assert.ok(autoBypassed(rows, { project: 'C:\\proj\\a\\'.replace(/C:/, '').replace(/\\/g, '/'), now }).bypass.has('npm test'), 'path spelling normalised');
  const stale = rows.map((r) => ({ ...r, at: at(30) }));
  assert.ok(!autoBypassed(stale, { project: '/proj/a', now }).bypass.has('npm test'), 'expired after 14 days');
  // Archived per-project counts still count while recent.
  const archive = { families: { '/proj/a\u0000git log': { compressed: 1, expanded: 2, last: now - 864e5 } } };
  assert.ok(autoBypassed([], { project: '/proj/a', now, archive }).bypass.has('git log'));
  assert.ok(!autoBypassed([], { project: '/proj/b', now, archive }).bypass.has('git log'));
});

// ---------------------------------------------------------------- re-read note misses
test('a re-read note that the agent works around is counted, and notes stop in that project', () => {
  const home = fresh();
  const content = Array.from({ length: 150 }, (_, i) => `export function handler${i}(req, res) { return process(req, ${i}); }`).join('\n');
  const read = (file, extra = {}) => ({ session_id: 'r1', cwd: '/proj/r', tool_name: 'Read', tool_input: { file_path: file, ...extra }, tool_response: { type: 'text', file: { filePath: file, content, numLines: 150 } } });
  for (const f of ['/p/a.js', '/p/b.js']) {
    hook(read(f), home);
    assert.match(hook(read(f), home).hookSpecificOutput.updatedToolOutput.file.content, /Unchanged since/);
    assert.strictEqual(hook(read(f, { limit: 100000 }), home), null, 'full re-read served');
  }
  const ledger = fs.readFileSync(path.join(home, 'gain.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(ledger.filter((e) => e.kind === 'expand' && e.family === 'read').length, 2);
  hook(read('/p/c.js'), home);
  assert.strictEqual(hook(read('/p/c.js'), home), null, 'notes switched off for this project');
  hook({ ...read('/p/c.js'), cwd: '/proj/other' }, home);
  assert.match(hook({ ...read('/p/c.js'), cwd: '/proj/other' }, home).hookSpecificOutput.updatedToolOutput.file.content, /Unchanged since/, 'other projects keep them');
});

// ---------------------------------------------------------------- retention
test('retention deletes raw logs and sessions older than the limit, keeps recent ones', () => {
  const home = fresh();
  const raw = path.join(home, 'raw');
  const sess = path.join(home, 'sessions');
  fs.mkdirSync(raw, { recursive: true });
  fs.mkdirSync(path.join(sess, 'old'), { recursive: true });
  fs.mkdirSync(path.join(sess, 'new'), { recursive: true });
  const old = (Date.now() - 10 * 864e5) / 1000;
  for (const [f, isOld] of [[path.join(raw, '1-a.log'), true], [path.join(raw, '2-b.log'), false], [path.join(sess, 'old', 'reads.json'), true], [path.join(sess, 'new', 'reads.json'), false]]) {
    fs.writeFileSync(f, 'x');
    if (isOld) fs.utimesSync(f, old, old);
  }
  const r = inHome(home, `console.log(JSON.stringify(require('./src/retention').prune({ force: true })))`);
  assert.deepStrictEqual(r, { raw: 1, sessions: 1, skipped: false });
  assert.ok(fs.existsSync(path.join(raw, '2-b.log')) && !fs.existsSync(path.join(raw, '1-a.log')));
  assert.ok(fs.existsSync(path.join(sess, 'new')) && !fs.existsSync(path.join(sess, 'old')));
  assert.strictEqual(inHome(home, `console.log(JSON.stringify(require('./src/retention').prune()))`).skipped, true, 'at most once an hour');
});
