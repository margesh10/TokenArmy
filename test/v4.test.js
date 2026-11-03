'use strict';
// Environment facts, elision summaries, terraform/mypy/go/cargo/gradle filters, unused-MCP audit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { applyFilter } = require('../src/filters');
const { describe: summarize, dedupeRuns, smartTruncate, squeeze } = require('../src/squeeze');
const { unresolved, formOf } = require('../src/facts');
const { mcpUsage } = require('../src/audit');

const ROOT = path.join(__dirname, '..');
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ta4-'));
function run(script, evt, home, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', script)], {
    input: JSON.stringify(evt),
    encoding: 'utf8',
    env: { ...process.env, TOKENARMY_OFF: '', TOKENARMY_FACTS: '', TOKENARMY_HOME: home, ...extraEnv },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const bash = (sid, cwd, command, stdout, stderr = '') => ({ session_id: sid, cwd, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr, interrupted: false, isImage: false } });
const start = (sid, cwd, source = 'startup') => ({ session_id: sid, cwd, hook_event_name: 'SessionStart', source });

// ---------------------------------------------------------------- environment facts

test('facts: unresolved commands are recognised in bash, PowerShell, cmd, python -m and npx', () => {
  assert.deepStrictEqual(unresolved('pytest -q', 'bash: pytest: command not found'), { tool: 'pytest', form: 'pytest', error: 'command not found' });
  assert.strictEqual(unresolved('cd app && tsc --noEmit', '/usr/bin/bash: line 1: tsc: command not found').form, 'tsc');
  assert.strictEqual(unresolved('pytest', "pytest : The term 'pytest' is not recognized as the name of a cmdlet, function, script file").error, 'not recognized');
  assert.strictEqual(unresolved('jest', "'jest' is not recognized as an internal or external command,").tool, 'jest');
  assert.deepStrictEqual(unresolved('python -m pytest -q', '/usr/bin/python: No module named pytest'), { tool: 'pytest', form: 'python -m pytest', error: 'No module named' });
  assert.strictEqual(unresolved('npx tsc', 'npm ERR! could not determine executable to run').form, 'npx tsc');
  assert.strictEqual(unresolved('python app.py', "ModuleNotFoundError: No module named 'requests'"), null, 'a missing import in the code is not a command spelling problem');
  assert.strictEqual(unresolved('npm test', 'FAIL src/a.test.js\n  Error: expected 3'), null, 'a failing test is not unresolved');
});

test('facts: the form of a tool is what was typed up to the tool', () => {
  assert.strictEqual(formOf('FOO=1 .venv/bin/python -m pytest -q tests/', 'pytest'), '.venv/bin/python -m pytest');
  assert.strictEqual(formOf('cd web && npx tsc --noEmit', 'tsc'), 'npx tsc');
  assert.strictEqual(formOf('uv run pytest -x', 'pytest'), 'uv run pytest');
  assert.strictEqual(formOf('pip install pytest', 'pytest'), null, 'installing is not running');
  assert.strictEqual(formOf('which pytest', 'pytest'), null);
});

test('facts: fail-then-work in 2 sessions becomes a fact stated at SessionStart; small outputs count', () => {
  const home = fresh();
  const cwd = fresh();
  assert.strictEqual(run('claude-lifecycle.js', start('s0', cwd), home), null, 'nothing learned yet');
  for (const sid of ['s1', 's2']) {
    assert.strictEqual(run('claude-posttooluse.js', bash(sid, cwd, 'pytest -q', '', 'bash: pytest: command not found'), home), null);
    run('claude-posttooluse.js', bash(sid, cwd, 'python -m pytest -q', '3 passed in 0.12s'), home);
    if (sid === 's1') assert.strictEqual(run('claude-lifecycle.js', start('s1b', cwd), home), null, 'one session is only a candidate');
  }
  const ctx = run('claude-lifecycle.js', start('s3', cwd), home).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Project brief from earlier sessions in this repository/);
  assert.match(ctx, /`pytest` fails here \(command not found\); `python -m pytest` works\./);
  assert.ok(ctx.length < 600, 'the block is small');
  assert.doesNotMatch(JSON.stringify(run('claude-lifecycle.js', start('s4', cwd), home, { TOKENARMY_FACTS: '0' })), /fails here/, 'TOKENARMY_FACTS=0 turns facts off');
  const other = fresh();
  assert.strictEqual(run('claude-lifecycle.js', start('s5', other), home), null, 'facts are per repository');
  // Restated after compaction too, next to the checkpoint.
  const after = run('claude-lifecycle.js', start('s3', cwd, 'compact'), home).hookSpecificOutput.additionalContext;
  assert.match(after, /python -m pytest/);
});

test('facts: a fact retires after the bare form works in 2 sessions in a row', () => {
  const home = fresh();
  const cwd = fresh();
  for (const sid of ['a', 'b']) {
    run('claude-posttooluse.js', bash(sid, cwd, 'tsc --noEmit', '', 'sh: 1: tsc: not found'), home);
    run('claude-posttooluse.js', bash(sid, cwd, 'npx tsc --noEmit', ''), home);
  }
  assert.match(JSON.stringify(run('claude-lifecycle.js', start('c', cwd), home)), /fails here/, 'active');
  run('claude-posttooluse.js', bash('d', cwd, 'tsc --noEmit', ''), home);
  assert.match(JSON.stringify(run('claude-lifecycle.js', start('d2', cwd), home)), /fails here/, 'one contradicting session is not enough');
  run('claude-posttooluse.js', bash('e', cwd, 'tsc --noEmit', ''), home);
  assert.doesNotMatch(JSON.stringify(run('claude-lifecycle.js', start('f', cwd), home)), /fails here/, 'retired after two in a row');
});

test('facts: installing the tool and re-running the same form teaches nothing', () => {
  const home = fresh();
  const cwd = fresh();
  for (const sid of ['x', 'y']) {
    run('claude-posttooluse.js', bash(sid, cwd, 'pytest', '', 'bash: pytest: command not found'), home);
    run('claude-posttooluse.js', bash(sid, cwd, 'pip install pytest', 'Successfully installed pytest-8.0.0'), home);
    run('claude-posttooluse.js', bash(sid, cwd, 'pytest', '1 passed'), home);
    run('claude-posttooluse.js', bash(sid, cwd, 'python -m pytest', '1 passed'), home);
  }
  assert.doesNotMatch(JSON.stringify(run('claude-lifecycle.js', start('z', cwd), home)), /fails here/);
});

test('facts: the CLI lists facts and can forget them', () => {
  const home = fresh();
  const cwd = fresh();
  for (const sid of ['p', 'q']) {
    run('claude-posttooluse.js', bash(sid, cwd, 'jest', '', "'jest' is not recognized as an internal or external command,"), home);
    run('claude-posttooluse.js', bash(sid, cwd, 'npx jest', 'Tests: 4 passed'), home);
  }
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'tokenarmy.js'), ...a], { encoding: 'utf8', env: { ...process.env, TOKENARMY_HOME: home } });
  const out = cli('facts', cwd).stdout;
  assert.match(out, /\[active\s*\] `jest` fails here \(not recognized\); `npx jest` works\./);
  assert.match(cli('facts', '--clear', cwd).stdout, /Forgot every fact/);
  assert.match(cli('facts', cwd).stdout, /None yet/);
});

// ---------------------------------------------------------------- elision summaries

test('describe: states levels, constant fields, exact value counts and ranges of hidden lines', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `2026-11-03T10:00:${String(i % 60).padStart(2, '0')} INFO request method=GET status=${i % 10 === 0 ? 404 : 200} ms=${3 + i}`);
  const d = summarize(lines);
  assert.match(d, /INFO×40/);
  assert.match(d, /status: 200×36 404×4/);
  assert.match(d, /method=GET/);
  assert.match(d, /ms=3\.\.42/);
  assert.match(d, /no problem lines/);
  const ids = summarize(['id=a1 x', 'id=b2 x', 'id=c3 x']);
  assert.doesNotMatch(ids, /id[:=]/, 'all-distinct values are identifiers, not a shared fact');
  const mixed = summarize(['t=1s a', 't=200ms a', 't=3s a']);
  assert.doesNotMatch(mixed, /t=/, 'no range across different units');
  assert.match(summarize(['ok', 'Error: disk full', 'ok']), /1 problem line among them/);
  assert.strictEqual(summarize(['a', 'b']), '', 'too few lines to describe');
});

test('dedupeRuns keeps the first and last line of a long run; smartTruncate markers describe what they hide', () => {
  const run = Array.from({ length: 10 }, (_, i) => `Downloading chunk ${i + 1}/10`);
  const out = dedupeRuns(run);
  assert.deepStrictEqual([out[0], out[2]], ['Downloading chunk 1/10', 'Downloading chunk 10/10']);
  assert.match(out[1], /8 more similar lines/);
  const big = Array.from({ length: 400 }, (_, i) => `[worker ${i % 7}] DEBUG tick n=${i} queue=main`);
  const t = smartTruncate(big, 60).join('\n');
  assert.match(t, /lines omitted by tokenarmy: DEBUG×\d+; queue=main; n=\d+\.\.\d+; no problem lines\]/);
});

test('squeeze: an ordinary log keeps every error and says the hidden part had none', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `level=info msg="handled" path=/api/v1/items/${i} status=200 dur=${i % 50}ms`);
  lines[250] = 'level=error msg="db timeout" path=/api/v1/items/250 status=500';
  const out = squeeze(lines.join('\n'), { maxLines: 80 });
  assert.match(out, /db timeout/);
  assert.match(out, /INFO×\d+/);
});

// ---------------------------------------------------------------- filters

test('terraform plan: refresh/read noise hidden, actions and summary kept', () => {
  const refresh = Array.from({ length: 30 }, (_, i) => `aws_s3_bucket.b${i}: Refreshing state... [id=bucket-${i}]`);
  const body = ['', 'Terraform will perform the following actions:', '', '  # aws_instance.web will be updated in-place', '  ~ resource "aws_instance" "web" {', '      ~ instance_type = "t3.micro" -> "t3.small"', '    }', '', 'Plan: 0 to add, 1 to change, 0 to destroy.'];
  const out = applyFilter('terraform plan -out=tf.plan', [...refresh, ...body].join('\n'));
  assert.match(out, /^\[tokenarmy\] 30 refresh\/read\/progress lines hidden/);
  assert.ok(!/Refreshing state/.test(out));
  assert.match(out, /~ instance_type = "t3.micro" -> "t3.small"/);
  assert.match(out, /Plan: 0 to add, 1 to change, 0 to destroy\./);
  const err = applyFilter('tofu apply', [...refresh, 'aws_instance.web: Still creating... [10s elapsed]', 'Error: creating EC2 Instance: UnauthorizedOperation'].join('\n'));
  assert.match(err, /Error: creating EC2 Instance/);
});

test('mypy: file:line diagnostics without a column are grouped with every location', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `app/m${i}.py:${10 + i}: error: Incompatible return value type (got "str", expected "int")  [return-value]`);
  lines.push('Found 12 errors in 12 files (checked 40 source files)');
  const out = applyFilter('mypy app', lines.join('\n'));
  assert.match(out, /\(×12\)/);
  assert.match(out, /app\/m0\.py:10, app\/m1\.py:11/);
  assert.match(out, /Found 12 errors/);
});

test('go test -v and cargo test: passing tests hidden, failures and summaries kept', () => {
  const go = [];
  for (let i = 0; i < 40; i++) go.push(`=== RUN   TestThing${i}`, `--- PASS: TestThing${i} (0.00s)`);
  go.push('=== RUN   TestBroken', '    broken_test.go:17: got 3, want 4', '--- FAIL: TestBroken (0.00s)', 'FAIL', 'FAIL\texample.com/pkg\t0.012s');
  const g = applyFilter('go test -v ./...', go.join('\n'));
  assert.ok(!/TestThing/.test(g));
  assert.match(g, /broken_test\.go:17: got 3, want 4/);
  assert.match(g, /--- FAIL: TestBroken/);
  const cargo = ['running 31 tests', ...Array.from({ length: 30 }, (_, i) => `test tests::case_${i} ... ok`), 'test tests::overflow ... FAILED', '', 'failures:', '', "---- tests::overflow stdout ----", "thread 'tests::overflow' panicked at src/lib.rs:42:9:", 'attempt to add with overflow', '', 'test result: FAILED. 30 passed; 1 failed; 0 ignored'];
  const c = applyFilter('cargo test', cargo.join('\n'));
  assert.ok(!/case_\d+ \.\.\. ok/.test(c));
  assert.match(c, /panicked at src\/lib\.rs:42:9/);
  assert.match(c, /test result: FAILED\. 30 passed; 1 failed/);
  assert.ok(applyFilter('cargo nextest run', cargo.join('\n')), 'nextest uses the test filter');
});

test('gradle: daemon chatter and task lines collapsed, failure kept', () => {
  const lines = ['Starting a Gradle Daemon (subsequent builds will be faster)', 'Welcome to Gradle 8.5!', ...Array.from({ length: 30 }, (_, i) => `> Task :lib${i}:compileJava UP-TO-DATE`), '> Task :app:compileJava FAILED', 'FAILURE: Build failed with an exception.', '* What went wrong:', "Execution failed for task ':app:compileJava'.", 'BUILD FAILED in 4s'];
  const out = applyFilter('./gradlew build', lines.join('\n'));
  assert.match(out, /progress lines collapsed: .*> Task ×30/);
  assert.ok(!/^Welcome to Gradle/m.test(out), 'only counted in the summary line');
  assert.match(out, /> Task :app:compileJava FAILED/);
  assert.match(out, /BUILD FAILED in 4s/);
});

// ---------------------------------------------------------------- audit

test('audit: MCP servers never called in recent sessions of a project are found', () => {
  const home = fresh();
  const root = path.join(fresh(), 'proj');
  fs.mkdirSync(root);
  const dir = path.join(home, '.claude', 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 6; i++) {
    const call = i === 2 ? '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__github__create_issue","input":{}}]}}' : '{"type":"user"}';
    fs.writeFileSync(path.join(dir, `s${i}.jsonl`), call + '\n');
  }
  const u = mcpUsage(root, home);
  assert.strictEqual(u.sessions, 6);
  assert.deepStrictEqual([...u.used], ['github']);
  assert.strictEqual(mcpUsage(path.join(root, 'nope'), home), null);
});

// ---------------------------------------------------------------- redaction

test('redact: secrets never reach raw logs on disk; ordinary text is untouched', () => {
  const { redact } = require('../src/redact');
  const s = redact(['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', 'AKIAABCDEFGHIJKLMNOP', 'DB_PASSWORD=hunter2hunter2', 'postgres://app:s3cretpw@db:5432/x', 'Authorization: Bearer abcdefghijklmnop1234', 'PASSWORD_MIN_LENGTH is a setting'].join('\n'));
  assert.ok(!/sk-ant-api03|ghp_abc|AKIAABCD|hunter2|s3cretpw|abcdefghijklmnop1234/.test(s), s);
  assert.match(s, /\[REDACTED:anthropic_key\]/);
  assert.match(s, /DB_PASSWORD=\[REDACTED:secret_value\]/);
  assert.match(s, /postgres:\/\/app:\[REDACTED:url_password\]@db/);
  assert.match(s, /PASSWORD_MIN_LENGTH is a setting/);
  const home = fresh();
  const big = Array.from({ length: 300 }, (_, i) => `line ${i} GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB`).join('\n');
  const r = run('claude-posttooluse.js', bash('r1', home, 'env', big), home);
  const raw = r.hookSpecificOutput.updatedToolOutput.stdout.match(/full output: (.+?)\]/)[1];
  assert.ok(!fs.readFileSync(raw, 'utf8').includes('ghp_abc'), 'raw copy redacted');
});

// ---------------------------------------------------------------- project brief

test('brief: commands that ran clean, files read often and failures still open are stated with session counts', () => {
  const home = fresh();
  const cwd = fresh();
  const read = (sid, f) => ({ session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, f) }, tool_response: { type: 'text', file: { filePath: path.join(cwd, f), content: 'x', numLines: 1 } } });
  for (const sid of ['b1', 'b2', 'b3']) {
    run('claude-posttooluse.js', bash(sid, cwd, 'cd web && npm test -- --silent 2>&1 | tail -20', 'Tests: 12 passed, 12 total'), home);
    run('claude-posttooluse.js', bash(sid, cwd, 'npx tsc --noEmit', "src/a.ts(3,1): error TS2307: Cannot find module 'left-pad'."), home);
    run('claude-posttooluse.js', bash(sid, cwd, 'ls -la', 'a\nb'), home);
    run('claude-posttooluse.js', read(sid, 'src/core.js'), home);
    if (sid !== 'b3') run('claude-posttooluse.js', read(sid, 'README.md'), home);
  }
  run('claude-posttooluse.js', read('b1', path.join('..', 'outside.js')), home);
  const ctx = run('claude-lifecycle.js', start('b4', cwd), home).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Commands that ran clean here: `npm test -- --silent` \(3\)/);
  assert.ok(!/ls -la/.test(ctx), 'only verification commands');
  assert.match(ctx, /Files read in most sessions: src\/core\.js \(3\)/);
  assert.ok(!/README|outside/.test(ctx), 'fewer than 3 sessions, or outside the repo: left out');
  assert.match(ctx, /Still failing at the end of earlier sessions: `npx tsc`: "src\/a\.ts\(3,1\): error TS2307/);
  // Fixed once: the failure drops out.
  run('claude-posttooluse.js', bash('b5', cwd, 'npx tsc --noEmit', ''), home);
  const after = run('claude-lifecycle.js', start('b6', cwd), home).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(after, /Still failing/);
  assert.ok(after.length < 1000);
  assert.strictEqual(run('claude-lifecycle.js', start('b7', cwd), home, { TOKENARMY_BRIEF: '0' }), null, 'TOKENARMY_BRIEF=0 turns it off');
});
