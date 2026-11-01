'use strict';
// git diff/transfer, lint, build-progress and table filters; JSON compression; the loop guard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { applyFilter } = require('../src/filters');
const { crushJson } = require('../src/json');

const ROOT = path.join(__dirname, '..');
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ta3-'));
function hook(evt, home) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'claude-posttooluse.js')], {
    input: JSON.stringify(evt),
    encoding: 'utf8',
    env: { ...process.env, TOKENARMY_OFF: '', TOKENARMY_HOME: home },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('git diff: headers stripped, one context line around changes', () => {
  const body = Array.from({ length: 30 }, (_, i) => ` unchanged line ${i}`);
  body.splice(15, 0, '-old value', '+new value');
  const diff = ['diff --git a/src/app.js b/src/app.js', 'index 1a2b3c4..5d6e7f8 100644', '--- a/src/app.js', '+++ b/src/app.js', '@@ -1,31 +1,31 @@ function main() {', ...body].join('\n');
  const out = applyFilter('git diff', diff);
  assert.match(out, /^=== src\/app\.js/);
  assert.ok(!/index 1a2b3c4|^--- a\/|^\+\+\+ b\//m.test(out));
  assert.match(out, / unchanged line 14\n-old value\n\+new value\n unchanged line 15/);
  assert.match(out, /… 14 unchanged lines/);
  assert.strictEqual(applyFilter('git diff --stat', diff), null, '--stat is left alone');
});

test('git push/pull: transfer progress hidden, refs and errors kept', () => {
  const out = applyFilter('git push origin main', ['Enumerating objects: 15, done.', 'Counting objects: 100% (15/15), done.', 'Delta compression using up to 8 threads', 'Compressing objects: 100% (8/8), done.', 'Writing objects: 100% (8/8), 1.2 KiB | 1.2 MiB/s, done.', 'Total 8 (delta 5), reused 0 (delta 0)', 'remote: Resolving deltas: 100% (5/5), completed with 5 local objects.', 'To github.com:me/repo.git', '   1234567..89abcde  main -> main'].join('\n'));
  assert.strictEqual(out, 'To github.com:me/repo.git\n   1234567..89abcde  main -> main');
  const rej = applyFilter('git push', 'Counting objects: 3\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs');
  assert.match(rej, /rejected/);
  assert.match(rej, /error: failed to push/);
});

test('ruff/flake8 codes grouped by rule with every location', () => {
  const lines = [];
  for (let i = 1; i <= 12; i++) lines.push(`src/m${i}.py:${i}:80: E501 Line too long (${100 + i} > 88)`);
  for (let i = 1; i <= 3; i++) lines.push(`src/u${i}.py:${i}:1: F401 \`os\` imported but unused`);
  lines.push('Found 15 errors.');
  const out = applyFilter('ruff check .', lines.join('\n'));
  assert.match(out, /^E501 Line too long \(101 > 88\) \(\+11 variants\) \(×12\)/);
  for (let i = 1; i <= 12; i++) assert.ok(out.includes(`src/m${i}.py:${i}`));
  assert.match(out, /F401 .* \(×3\)/);
  assert.match(out, /Found 15 errors/);
});

test('build progress collapsed to counts; warnings and errors kept', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(`   Compiling crate${i} v0.${i}.0`);
  for (let i = 0; i < 20; i++) lines.push(`  Downloaded dep${i} v1.0.${i}`);
  lines.push('warning: unused variable: `x`', '    Finished dev [unoptimized] target(s) in 12.3s');
  const out = applyFilter('cargo run', lines.join('\n'));
  assert.match(out, /60 progress lines collapsed: Compiling ×40, Downloaded ×20/);
  assert.match(out, /warning: unused variable/);
  assert.match(out, /Finished dev/);
  const mvn = Array.from({ length: 30 }, (_, i) => `[INFO] Downloading from central: https://repo/x${i}.jar`).join('\n') + '\n[ERROR] Failed to execute goal compile';
  assert.match(applyFilter('mvn package', mvn), /\[ERROR\] Failed to execute goal/);
});

test('kubectl/docker tables: unhealthy rows first, then a sample and a count', () => {
  const rows = ['NAME   READY   STATUS    RESTARTS   AGE'];
  for (let i = 0; i < 80; i++) rows.push(`web-${i}   1/1   ${i === 57 ? 'CrashLoopBackOff' : 'Running'}   0   2d`);
  const out = applyFilter('kubectl get pods -A', rows.join('\n'));
  const lines = out.split('\n');
  assert.strictEqual(lines[0], rows[0]);
  assert.match(lines[1], /web-57 .*CrashLoopBackOff/);
  assert.match(out, /… \+54 more rows \(80 total, 1 unhealthy shown first\)/);
});

test('crushJson: arrays of objects become a table, error items always shown', () => {
  const data = { total: 50, items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `svc-${i}`, owner: { login: 'ops', id: 7 }, status: i === 42 ? 'error: disk full' : 'ok', notes: 'x'.repeat(300) })) };
  const raw = JSON.stringify(data, null, 2);
  const out = crushJson(raw);
  assert.match(out, /^total: 50/);
  assert.match(out, /items: \[50 items\] id \| name \| owner \| status \| notes/);
  assert.match(out, /- 0 \| svc-0 \| login=ops,id=7 \| ok/);
  assert.match(out, /- 42 \| svc-42 .* error: disk full/);
  assert.match(out, /… \+34 more items/);
  assert.ok(out.length < raw.length / 8, `${out.length} vs ${raw.length}`);
  assert.strictEqual(crushJson('not json'), null);
  assert.strictEqual(crushJson('{"broken": '), null);
  assert.match(crushJson(JSON.stringify({ big: 'y'.repeat(1000) })), /big: "y{160}"…\(\+840 chars\)/);
});

test('hook compresses JSON output from curl/gh but not when the agent piped it through jq', () => {
  const home = fresh();
  const json = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ number: i, title: `Issue number ${i} about the parser`, state: 'open', user: { login: 'dev' } })), null, 2);
  const evt = (command) => ({ session_id: 'j', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: json, stderr: '', interrupted: false, isImage: false } });
  const out = hook(evt('gh api repos/o/r/issues'), home).hookSpecificOutput.updatedToolOutput.stdout;
  assert.match(out, /^\[60 items\] number \| title \| state \| user/);
  const jq = hook(evt("gh api repos/o/r/issues | jq '.[0]'"), home);
  assert.ok(!jq || jq.hookSpecificOutput.updatedToolOutput.stdout.includes('"title": "Issue number 59'), 'narrowed with jq: no lines cut');
});

test('loop guard: third identical failure gets a note; success resets it', () => {
  const home = fresh();
  const fail = { session_id: 'loop1', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'FAIL src/a.test.js\n  Error: expected 3 to equal 4 (line 12)', stderr: '', interrupted: false, isImage: false } };
  assert.strictEqual(hook(fail, home), null);
  assert.strictEqual(hook(fail, home), null);
  const third = hook(fail, home).hookSpecificOutput.updatedToolOutput.stdout;
  assert.ok(third.startsWith('FAIL src/a.test.js'), 'original output intact');
  assert.match(third, /`npm test` has now failed 3 times in a row with the same error/);
  const ok = { ...fail, tool_response: { ...fail.tool_response, stdout: 'Tests: 12 passed' } };
  hook(ok, home);
  assert.strictEqual(hook(fail, home), null, 'counter reset after a pass');
});
