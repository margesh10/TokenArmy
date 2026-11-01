'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { estimateTokens } = require('../src/tokens');
const { squeeze, dedupeRuns } = require('../src/squeeze');
const { applyFilter } = require('../src/filters');
const slop = require('../src/slop');
const prompt = require('../src/prompt');
const ctx = require('../src/context');

test('estimateTokens is in a sane range', () => {
  const t = estimateTokens('The quick brown fox jumps over the lazy dog.');
  assert.ok(t >= 9 && t <= 14, `got ${t}`);
  assert.strictEqual(estimateTokens(''), 0);
});

test('squeeze strips ANSI, progress bars and collapses repeats', () => {
  const lines = ['\x1b[32mstarting\x1b[0m', 'downloading 10%\rdownloading 50%\rdownloading 100%'];
  for (let i = 0; i < 50; i++) lines.push(`fetched package-${i}@1.0.${i}`);
  lines.push('ERROR: build failed at step 3');
  const out = squeeze(lines.join('\n'));
  assert.ok(!out.includes('\x1b'));
  assert.ok(out.includes('ERROR: build failed'));
  assert.ok(out.includes('more similar line'));
  assert.ok(out.split('\n').length < 10);
});

test('smart truncate keeps errors buried in the middle', () => {
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`line ${i} ${'x'.repeat(i % 7)} ok-${i * 7919 % 13}`);
  lines[500] = 'Traceback: something exploded here';
  const out = squeeze(lines.join('\n'), { maxLines: 60 });
  assert.ok(out.includes('Traceback: something exploded here'));
});

test('dedupeRuns leaves short runs alone', () => {
  assert.deepStrictEqual(dedupeRuns(['a 1', 'a 2']), ['a 1', 'a 2']);
});

test('git status filter', () => {
  const raw = `On branch main
Your branch is ahead of 'origin/main' by 2 commits.
  (use "git push" to publish your local commits)

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
\tmodified:   src/a.js
\tmodified:   src/b.js

Untracked files:
  (use "git add <file>..." to include in what will be committed)
\tnotes.txt
`;
  const out = applyFilter('git status', raw);
  assert.match(out, /branch main \+2/);
  assert.match(out, /modified \(2\): M src\/a.js, M src\/b.js/);
  assert.match(out, /untracked \(1\): notes.txt/);
});

test('test-runner filter hides passes, keeps failures', () => {
  const raw = [
    ...Array.from({ length: 40 }, (_, i) => `  ✓ handles case ${i} (3 ms)`),
    '  ✓ handles error input (1 ms)',
    '  ● math › adds',
    '    expect(received).toBe(expected)',
    '    Expected: 3',
    '    Received: 4',
    'Tests:       1 failed, 41 passed, 42 total',
  ].join('\n');
  const out = applyFilter('npx jest', raw);
  assert.ok(!out.includes('handles case 12'));
  assert.ok(out.includes('● math › adds'));
  assert.ok(out.includes('Received: 4'));
  assert.ok(out.includes('Tests:       1 failed'));
  assert.match(out, /41 passing test lines hidden/);
});

test('deeply indented stack/code lines are not mistaken for progress bars', () => {
  const raw = ['  ● suite › case', '', '      42 |   const t = total(cart);', '    > 43 |   expect(t).toBe(1);', '      at Object.<anonymous> (src/x.test.ts:43:13)', 'Tests: 1 failed, 1 total'].join('\n');
  const out = squeeze(raw, { command: 'npx jest' });
  assert.ok(out.includes('42 |   const t = total(cart);'));
  assert.ok(out.includes('at Object.<anonymous> (src/x.test.ts:43:13)'));
});

test('compiler diagnostics keep every file:line location', () => {
  const raw = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts(${i + 1},5): error TS2532: Object is possibly 'undefined'.`).join('\n') + '\nFound 12 errors in 12 files.';
  const out = applyFilter('npx tsc --noEmit', raw);
  for (let i = 0; i < 12; i++) assert.ok(out.includes(`src/m${i}.ts:${i + 1}`), `missing m${i}`);
  assert.match(out, /TS2532: Object is possibly 'undefined'\. \(×12\)/);
  assert.ok(out.length < raw.length);
});

test('install filter keeps vulnerabilities and summary only', () => {
  const raw = ['npm WARN deprecated foo@1.0.0: use bar', ...Array.from({ length: 200 }, (_, i) => `http fetch GET 200 https://registry/x${i}`), 'added 312 packages in 9s', '3 high severity vulnerabilities'].join('\n');
  const out = applyFilter('npm install', raw);
  assert.ok(out.includes('added 312 packages'));
  assert.ok(out.includes('vulnerabilities'));
  assert.ok(out.includes('WARN deprecated'));
  assert.ok(out.split('\n').length <= 4);
});

test('git log filter → one line per commit', () => {
  const raw = `commit 1234567890abcdef1234567890abcdef12345678
Author: Margesh <m@example.com>
Date:   Fri Oct 30 10:00:00 2026 -0400

    Add token squeezer

commit abcdef1234567890abcdef1234567890abcdef12
Author: Margesh <m@example.com>
Date:   Thu Oct 29 09:00:00 2026 -0400

    Initial commit
`;
  const out = applyFilter('git log', raw);
  assert.strictEqual(out.split('\n').length, 2);
  assert.match(out, /^1234567 Oct 30 2026 Margesh: Add token squeezer/);
});

test('slop score and fix', () => {
  const t = "Great question! It's important to note that we should leverage a robust, seamless approach. Let's dive into the realm of caching. I hope this helps!";
  const s = slop.score(t);
  assert.ok(s.per100words > 3, JSON.stringify(s));
  const fixed = slop.deslop(t);
  assert.ok(!/great question/i.test(fixed));
  assert.ok(!/hope this helps/i.test(fixed));
  assert.ok(/use/.test(fixed));
  assert.ok(fixed.length < t.length * 0.8);
});

test('deslop never touches code', () => {
  const t = 'Use this:\n```js\n// leverage robust seamless\nconst x = 1;\n```\nand `utilize()`.';
  const fixed = slop.deslop(t);
  assert.ok(fixed.includes('// leverage robust seamless'));
  assert.ok(fixed.includes('`utilize()`'));
});

test('prompt compress keeps code and quotes, removes waste', () => {
  const t = [
    '# Rules',
    '',
    '',
    '',
    'You must always run the tests before committing.',
    'You must always run the tests before committing.',
    '<!-- internal note -->',
    '**Important:** please use "pnpm" in order to install.',
    '```json',
    '{\n  "a": 1,\n  "b": [1, 2]\n}',
    '```',
    '```py',
    'x = 1',
    'x = 1',
    '```',
  ].join('\n');
  const out = prompt.compress(t, 2);
  assert.ok(out.includes('"pnpm"'));
  assert.ok(out.includes('{"a":1,"b":[1,2]}'));
  assert.ok(!out.includes('internal note'));
  assert.strictEqual(out.match(/run the tests/g).length, 1);
  assert.strictEqual(out.match(/x = 1/g).length, 2, 'code lines must not be deduped');
  assert.ok(out.includes('Always run the tests'));
});

test('compress leaves grammatical text after deletions', () => {
  const t = [
    "In today's fast-paced world of software development, it's important to note that tests matter.",
    'This is a **robust**, **seamless**, cutting-edge e-commerce platform.',
    'We deliver a world-class experience.',
    '- Please make sure to use "pnpm" instead of npm.',
    '- It should be noted that we use ESLint.',
    '- Due to the fact that we deploy on Fly.io, please make sure that you test first.',
    '- iOS builds run nightly.',
  ].join('\n');
  const out = prompt.compress(t, 2);
  assert.ok(!/\*\*/.test(out), out);
  assert.ok(!/^Of /m.test(out), out);
  assert.match(out, /^Tests matter\./m);
  assert.match(out, /an e-commerce platform/);
  assert.match(out, /an experience/);
  assert.match(out, /^- Use "pnpm" instead of npm\./m);
  assert.match(out, /^- We use ESLint\./m);
  assert.match(out, /^- Because we deploy on Fly\.io, test first\./m);
  assert.match(out, /^- iOS builds run nightly\./m, 'untouched lines keep their casing');
});

test('pack respects budget and finds relevant chunk', () => {
  const docs = [
    '# Billing\nInvoices are generated nightly by the billing cron job.',
    '# Auth\nUsers log in with OAuth; refresh tokens rotate every hour.',
    '# Deploy\nWe deploy with GitHub Actions to Fly.io.',
  ];
  const chunks = docs.flatMap((d, i) => ctx.chunk(d, { source: `doc${i}.md` }));
  const res = ctx.pack(chunks, 'how do refresh tokens rotate', 60);
  assert.ok(res.text.includes('refresh tokens rotate'));
  assert.ok(res.used <= 60);
  assert.ok(!res.text.includes('Fly.io'));
});

test('outline shrinks code to signatures', () => {
  const code = `const fs = require('fs');\nfunction alpha(a, b) {\n  const x = a + b;\n  return x * 2;\n}\nclass Beta {\n  run() {\n    return 1;\n  }\n}\nmodule.exports = { alpha, Beta };\n`;
  const out = ctx.outline(code, 'x.js');
  assert.match(out, /function alpha\(a, b\) \{ … \}/);
  assert.match(out, /class Beta/);
  assert.ok(!out.includes('return x * 2'));
});

test('import graph finds neighbours', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = ctx.walk(root, /\.js$/);
  const g = ctx.buildGraph(files);
  const n = ctx.neighbourhood(g, path.join(root, 'squeeze.js'), 1).map((x) => path.basename(x.file));
  assert.ok(n.includes('filters.js'));
  assert.ok(n.includes('squeeze-signal.js'));
});

test('Claude Code hook replaces large Bash output and keeps shape', () => {
  const stdout = Array.from({ length: 300 }, (_, i) => `  ✓ test number ${i} passes (2 ms)`).join('\n') + '\n  ● suite › breaks\n    Error: boom\nTests: 1 failed, 300 passed';
  const evt = { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false } };
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'claude-posttooluse.js')], {
    input: JSON.stringify(evt),
    encoding: 'utf8',
    // Drop the user's opt-out so the test checks the hook itself, not their shell.
    env: { ...process.env, TOKENARMY_OFF: '', TOKENARMY_HOME: path.join(require('os').tmpdir(), 'tokenarmy-test') },
  });
  const out = JSON.parse(r.stdout);
  const u = out.hookSpecificOutput.updatedToolOutput;
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.strictEqual(u.interrupted, false);
  assert.strictEqual(u.isImage, false);
  assert.ok(u.stdout.includes('Error: boom'));
  assert.ok(u.stdout.includes('full output:'));
  assert.ok(u.stdout.length < stdout.length / 5);
  assert.ok(!('permissionDecision' in out.hookSpecificOutput));
});

test('hook ignores small output and "# raw" commands', () => {
  const run = (evt) => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'claude-posttooluse.js')], { input: JSON.stringify(evt), encoding: 'utf8' }).stdout;
  assert.strictEqual(run({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a\nb' } }), '');
  const big = 'x y z\n'.repeat(2000);
  assert.strictEqual(run({ tool_name: 'Bash', tool_input: { command: 'cat f # raw' }, tool_response: { stdout: big } }), '');
});

test('statusline shows model, context, cost and per-session savings', () => {
  const fs = require('fs');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  fs.writeFileSync(
    path.join(home, 'gain.jsonl'),
    [
      { kind: 'hook:bash', session: 'abc', before: 3000, after: 200 },
      { kind: 'hook:bash', session: 'other', before: 9000, after: 100 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n'
  );
  const input = {
    session_id: 'abc',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    cost: { total_cost_usd: 1.234 },
    context_window: { context_window_size: 1000000, current_usage: { input_tokens: 5000, cache_read_input_tokens: 40000 } },
  };
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'tokenarmy.js'), 'statusline'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, TOKENARMY_HOME: home, NO_COLOR: '1' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Opus 5\.5/);
  assert.match(r.stdout, /\$1\.23/);
  assert.match(r.stdout, /saved 2\.8k/); // only session "abc" counted
  assert.match(r.stdout, /ctx 45/);
});

test('statusline survives empty stdin', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'tokenarmy.js'), 'statusline'], { input: '', encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().length > 0);
});
