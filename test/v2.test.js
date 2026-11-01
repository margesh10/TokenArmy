'use strict';
// Tests for search compression, re-read dedupe, learning loop, checkpoints and the A/B harness.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ta2-'));
function hook(file, evt, home, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', file)], {
    input: JSON.stringify(evt),
    encoding: 'utf8',
    env: { ...process.env, TOKENARMY_OFF: '', TOKENARMY_HOME: home, ...extraEnv },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const ledger = (home) => {
  try {
    return fs.readFileSync(path.join(home, 'gain.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------- search
test('compressSearch groups by file, counts the rest, keeps error hits', () => {
  const { compressSearch } = require('../src/search');
  const lines = [];
  for (let f = 0; f < 3; f++) for (let i = 1; i <= 30; i++) lines.push(`src/f${f}.js:${i}:  const value${i} = compute(${i});`);
  lines.push('src/f1.js:99:  throw new Error("boom")');
  const out = compressSearch(lines.join('\n'));
  assert.match(out, /91 matches in 3 files/);
  assert.match(out, /src\/f0\.js \(30 matches\)/);
  assert.match(out, /\+26 more in this file/);
  assert.ok(out.includes('throw new Error("boom")'), 'error hit must survive');
  assert.ok(out.length < lines.join('\n').length / 3);
  assert.strictEqual(compressSearch('just some prose\nwith no file refs'), null);
});

test('Grep tool results are compressed in content mode only', () => {
  const home = fresh();
  const content = Array.from({ length: 200 }, (_, i) => `lib/mod${i % 10}.py:${i + 1}:    return helper_function_number_${i}(argument_value)`).join('\n');
  const base = { session_id: 's1', tool_name: 'Grep', tool_input: { pattern: 'return' } };
  const out = hook('claude-posttooluse.js', { ...base, tool_response: { mode: 'content', numFiles: 0, filenames: [], content, numLines: 200 } }, home);
  const u = out.hookSpecificOutput.updatedToolOutput;
  assert.strictEqual(u.mode, 'content');
  assert.match(u.content, /200 matches in 10 files/);
  assert.match(u.content, /full output:/);
  assert.strictEqual(hook('claude-posttooluse.js', { ...base, tool_response: { mode: 'files_with_matches', filenames: ['a'], numFiles: 1 } }, home), null);
});

// ---------------------------------------------------------------- diff + read dedupe
test('diffLines shows only changed hunks with new line numbers', () => {
  const { diffLines } = require('../src/diff');
  const a = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const b = a.replace('line 20', 'line twenty').replace('line 40\n', '');
  const d = diffLines(a, b);
  assert.strictEqual(d.changes, 3);
  assert.match(d.text, /- line 20\n\+ line twenty/);
  assert.match(d.text, /- line 40/);
  assert.ok(!d.text.includes('line 5\n'));
  assert.strictEqual(diffLines(a, a).changes, 0);
});

function readEvt(content, extra = {}) {
  return {
    session_id: 'sess-read',
    tool_name: 'Read',
    tool_input: { file_path: '/p/big.js', ...extra },
    tool_response: { type: 'text', file: { filePath: '/p/big.js', content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } },
  };
}
const bigFile = Array.from({ length: 150 }, (_, i) => `export function handler${i}(request, response) { return process(request, ${i}); }`).join('\n');

test('re-reading an unchanged file returns a short note; first read is untouched', () => {
  const home = fresh();
  assert.strictEqual(hook('claude-posttooluse.js', readEvt(bigFile), home), null);
  const out = hook('claude-posttooluse.js', readEvt(bigFile), home);
  const c = out.hookSpecificOutput.updatedToolOutput.file.content;
  assert.match(c, /Unchanged since you read it/);
  assert.match(c, /limit/);
  assert.ok(c.length < 400);
  assert.strictEqual(ledger(home).at(-1).kind, 'hook:read-same');
  // A different range (explicit limit) is a different read: full content comes back.
  assert.strictEqual(hook('claude-posttooluse.js', readEvt(bigFile, { limit: 100000 }), home), null);
});

test('re-reading a changed file returns only the diff', () => {
  const home = fresh();
  hook('claude-posttooluse.js', readEvt(bigFile), home);
  const edited = bigFile.replace('process(request, 77)', 'processV2(request, 77)');
  const out = hook('claude-posttooluse.js', readEvt(edited), home);
  const c = out.hookSpecificOutput.updatedToolOutput.file.content;
  assert.match(c, /Changed since your earlier read/);
  assert.match(c, /\+ export function handler77\(request, response\) \{ return processV2/);
  assert.ok(c.length < bigFile.length / 5);
});

test('read dedupe is reset by SessionStart/PreCompact and respects TOKENARMY_READ_DEDUPE=0', () => {
  const home = fresh();
  hook('claude-posttooluse.js', readEvt(bigFile), home);
  hook('claude-lifecycle.js', { session_id: 'sess-read', hook_event_name: 'SessionStart', source: 'compact' }, home);
  assert.strictEqual(hook('claude-posttooluse.js', readEvt(bigFile), home), null, 'after compaction the file must be served in full');
  assert.strictEqual(hook('claude-posttooluse.js', readEvt(bigFile), home, { TOKENARMY_READ_DEDUPE: '0' }), null);
});

// ---------------------------------------------------------------- shell: narrowed commands, learning
const noisy = Array.from({ length: 300 }, (_, i) => `  ✓ test number ${i} passes (2 ms)`).join('\n') + '\n  ● suite › breaks\n    Error: boom\nTests: 1 failed, 300 passed';
const bashEvt = (command, stdout = noisy) => ({ session_id: 's-sh', cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false } });

test('commands the agent already narrowed (| tail, | grep …) only get lossless cleanup', () => {
  const home = fresh();
  const colored = noisy.split('\n').map((l) => `\x1b[32m${l}\x1b[0m`).join('\n');
  const out = hook('claude-posttooluse.js', bashEvt('npm test 2>&1 | tail -400', colored), home);
  const s = out.hookSpecificOutput.updatedToolOutput.stdout;
  assert.ok(!s.includes('\x1b['), 'ANSI stripped');
  assert.ok(s.includes('test number 150 passes'), 'no lines removed');
  assert.strictEqual(ledger(home).at(-1).mode, 'lossless');
});

test('family() normalises commands', () => {
  const { family } = require('../src/learn');
  assert.strictEqual(family('cd "C:/x y" && C:/venv/Scripts/python.exe -m pytest -q 2>&1 | tail -5'), 'python -m pytest');
  assert.strictEqual(family('git log --oneline -5'), 'git log');
  assert.strictEqual(family('FOO=1 npm test'), 'npm test');
  assert.strictEqual(family('Get-Content bench/x.txt'), 'get-content');
});

test('opening raw logs is tracked, and a family that keeps being expanded gets auto-bypassed', () => {
  const home = fresh();
  const first = hook('claude-posttooluse.js', bashEvt('npm test'), home);
  const rawPath = first.hookSpecificOutput.updatedToolOutput.stdout.match(/full output: (.+)\]$/)[1];
  const open = { session_id: 's-sh', tool_name: 'Read', tool_input: { file_path: rawPath }, tool_response: { type: 'text', file: { filePath: rawPath, content: 'x'.repeat(5000), numLines: 1 } } };
  assert.strictEqual(hook('claude-posttooluse.js', open, home), null, 'raw logs are never compressed');
  hook('claude-posttooluse.js', bashEvt('npm test'), home);
  hook('claude-posttooluse.js', open, home);
  assert.strictEqual(ledger(home).filter((e) => e.kind === 'expand').length, 2);
  const out = hook('claude-posttooluse.js', bashEvt('npm test'), home);
  assert.ok(!out || out.hookSpecificOutput.updatedToolOutput.stdout.includes('test number 150'), 'npm test is now hands-off');
});

test('user filters drop noise lines but never error lines; bypass list is respected', () => {
  const home = fresh();
  const proj = fresh();
  fs.mkdirSync(path.join(proj, '.tokenarmy'));
  fs.writeFileSync(path.join(proj, '.tokenarmy', 'filters.json'), JSON.stringify({ rules: [{ name: 'deploy-noise', cmd: 'deploy', drop: ['^uploading chunk', 'Error'] }], bypass: ['^make\\b'] }));
  const out = Array.from({ length: 200 }, (_, i) => `uploading chunk ${i} of 200 to bucket`).join('\n') + '\nError: upload rejected by server\ndone';
  const r = hook('claude-posttooluse.js', { ...bashEvt('./deploy.sh', out), cwd: proj }, home);
  const s = r.hookSpecificOutput.updatedToolOutput.stdout;
  assert.ok(s.includes('Error: upload rejected'), 'signal line survives even though a drop pattern matches it');
  assert.match(s, /200 lines dropped by filter "deploy-noise"/);
  const m = hook('claude-posttooluse.js', { ...bashEvt('make all'), cwd: proj }, home);
  assert.ok(!m || m.hookSpecificOutput.updatedToolOutput.stdout.includes('test number 150'));
});

test('learn mines repeated noise across raw logs into rules', () => {
  const home = fresh();
  const raw = path.join(home, 'raw');
  fs.mkdirSync(raw, { recursive: true });
  for (let k = 0; k < 3; k++) {
    const body = Array.from({ length: 30 }, (_, i) => `Downloading layer ${i}a${k}f: ${i * 10}%`).join('\n') + '\nfatal: pull failed';
    fs.writeFileSync(path.join(raw, `${1000 + k}-abc.log`), `$ docker pull app\n--- stdout ---\n${body}\n--- stderr ---\n`);
  }
  const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./src/learn").mine()))'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TOKENARMY_HOME: home } });
  const proposals = JSON.parse(r.stdout);
  assert.strictEqual(proposals.length, 1);
  assert.strictEqual(proposals[0].name, 'learned:docker pull');
  assert.ok(new RegExp(proposals[0].drop[0], 'i').test('Downloading layer 3a9f: 30%'));
  assert.ok(!proposals[0].drop.some((d) => new RegExp(d, 'i').test('fatal: pull failed')));
});

// ---------------------------------------------------------------- checkpoint
test('PreCompact saves a checkpoint and SessionStart:compact hands it back', () => {
  const home = fresh();
  const tp = path.join(home, 't.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Fix the look-ahead bug in backtest.run' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest -q' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, toolUseResult: { filePath: '/p/backtest.py', structuredPatch: [{}] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'rerun tests', status: 'pending' }] } }] } },
  ];
  fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.strictEqual(hook('claude-lifecycle.js', { session_id: 'cp1', hook_event_name: 'PreCompact', transcript_path: tp, trigger: 'auto' }, home), null);
  const out = hook('claude-lifecycle.js', { session_id: 'cp1', hook_event_name: 'SessionStart', source: 'compact' }, home);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx, /Fix the look-ahead bug/);
  assert.match(ctx, /\/p\/backtest\.py \(edited\)/);
  assert.match(ctx, /`pytest -q`/);
  assert.match(ctx, /\[ \] rerun tests/);
  assert.strictEqual(hook('claude-lifecycle.js', { session_id: 'cp1', hook_event_name: 'SessionStart', source: 'startup' }, home), null);
});

// ---------------------------------------------------------------- A/B harness safety
test('ab refuses a prompt that points the agent at the original project', async () => {
  const ab = require('../src/ab');
  const tpl = fresh();
  const cfg = path.join(fresh(), 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ template: tpl, prompt: `Run ${tpl.replace(/\\/g, '/')}/.venv/bin/python -m pytest` }));
  await assert.rejects(ab.ab(cfg, { out: fresh() }), /mentions the template path/);
});

// ---------------------------------------------------------------- A/B harness
test('ab: summarize() reports success and flags differences within noise', () => {
  const ab = require('../src/ab');
  const rows = ab.summarize([
    { side: 'off', ok: true, cost: 0.3, turns: 10, billed: { processed: 1000, output: 50 }, compressions: 0 },
    { side: 'off', ok: true, cost: 0.2, turns: 8, billed: { processed: 900, output: 40 }, compressions: 0 },
    { side: 'on', ok: true, cost: 0.25, turns: 9, billed: { processed: 950, output: 45 }, compressions: 2 },
    { side: 'on', ok: false, cost: 0.1, turns: 4, billed: { processed: 400, output: 20 }, compressions: 1 },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.strictEqual(by.success.off, '2/2');
  assert.strictEqual(by.success.on, '1/2');
  assert.strictEqual(by['cost $'].verdict, 'within noise');
  const h = ab.hooksSettings();
  assert.match(JSON.stringify(h), /Bash\|PowerShell\|Read\|Grep/);
  assert.ok(h.hooks.PreCompact && h.hooks.SessionStart);
});
