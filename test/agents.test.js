'use strict';
// GitHub Copilot and Devin support: payload adapters, replies, installers, Devin wrap mode, `run --b64`.
// Payload shapes follow each vendor's published hook reference (Nov 2026).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'tokenarmy.js');
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ag-'));
function run(file, input, { home, args = [], cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', file), ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: cwd || os.tmpdir(),
    env: { ...process.env, TOKENARMY_OFF: '', TOKENARMY_HOME: home || fresh(), ...env },
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
const noisy = Array.from({ length: 300 }, (_, i) => `  ✓ test number ${i} passes (2 ms)`).join('\n') + '\n  ● suite › breaks\n    Error: boom\nTests: 1 failed, 300 passed';
const bigFile = Array.from({ length: 150 }, (_, i) => `export function handler${i}(req, res) { return process(req, ${i}); }`).join('\n');

// ---------------------------------------------------------------- Copilot
const copilotCamel = (toolName, toolArgs, text, extra = {}) => ({ sessionId: 'cp-1', timestamp: Date.now(), cwd: os.tmpdir(), toolName, toolArgs, toolResult: { resultType: 'success', textResultForLlm: text }, ...extra });

test('Copilot (camelCase): noisy shell output is replaced via modifiedResult', () => {
  const home = fresh();
  const out = run('claude-posttooluse.js', copilotCamel('bash', { command: 'npm test' }, noisy), { home, args: ['--agent', 'copilot'] });
  assert.deepStrictEqual(Object.keys(out), ['modifiedResult']);
  assert.strictEqual(out.modifiedResult.resultType, 'success');
  const t = out.modifiedResult.textResultForLlm;
  assert.ok(t.includes('Error: boom'), 'failure kept');
  assert.ok(!t.includes('test number 150'), 'passing noise removed');
  assert.match(t, /full output:/);
  const last = ledger(home).at(-1);
  assert.strictEqual(last.agent, 'copilot');
  assert.ok(last.before > last.after);
});

test('Copilot: PowerShell tool on Windows, toolArgs as a JSON string, small output untouched', () => {
  const home = fresh();
  const out = run('claude-posttooluse.js', copilotCamel('powershell', JSON.stringify({ command: 'npm test' }), noisy), { home });
  assert.ok(out.modifiedResult.textResultForLlm.includes('Error: boom'));
  assert.strictEqual(run('claude-posttooluse.js', copilotCamel('bash', { command: 'ls' }, 'a\nb\nc'), { home }), null);
});

test('Copilot (PascalCase / snake_case payload) is understood too', () => {
  const evt = { hook_event_name: 'PostToolUse', session_id: 'cp-2', cwd: os.tmpdir(), tool_name: 'bash', tool_input: { command: 'npm test' }, tool_result: { result_type: 'success', text_result_for_llm: noisy } };
  const out = run('claude-posttooluse.js', evt);
  assert.ok(out.modifiedResult.textResultForLlm.includes('Error: boom'));
});

test('Copilot: re-viewing an unchanged file gets a note that points at view_range', () => {
  const home = fresh();
  const evt = copilotCamel('view', { path: '/p/big.js' }, bigFile);
  assert.strictEqual(run('claude-posttooluse.js', evt, { home }), null, 'first view untouched');
  const t = run('claude-posttooluse.js', evt, { home }).modifiedResult.textResultForLlm;
  assert.match(t, /Unchanged since you read it/);
  assert.match(t, /view_range/);
});

test('Copilot: grep results are grouped by file', () => {
  const content = Array.from({ length: 200 }, (_, i) => `lib/mod${i % 10}.py:${i + 1}:    return helper_function_number_${i}(argument_value)`).join('\n');
  const t = run('claude-posttooluse.js', copilotCamel('grep', { pattern: 'return' }, content)).modifiedResult.textResultForLlm;
  assert.match(t, /200 matches in 10 files/);
});

test('Copilot: tools we do not handle (edit, create, web_fetch) pass through', () => {
  assert.strictEqual(run('claude-posttooluse.js', copilotCamel('edit', { path: 'x' }, noisy)), null);
});

// ---------------------------------------------------------------- Devin
const devinEvt = (command, output, extra = {}) => ({ hook_event_name: 'PostToolUse', session_id: 'dv-1', prompt_id: 'p1', cwd: os.tmpdir(), tool_name: 'exec', tool_input: { command }, tool_response: { success: true, output, error: null }, ...extra });

test('Devin PostToolUse: output is never claimed as replaced (Devin cannot take it)', () => {
  const home = fresh();
  assert.strictEqual(run('claude-posttooluse.js', devinEvt('npm test', noisy), { home, args: ['--agent', 'devin'] }), null);
  assert.strictEqual(ledger(home).filter((e) => e.before > 0).length, 0, 'no savings recorded that did not happen');
});

test('Devin PostToolUse: loop guard arrives as additionalContext', () => {
  const home = fresh();
  const fail = devinEvt('npm test', 'FAIL src/a.test.js\n  Error: expected 3 to equal 4 (line 12)');
  run('claude-posttooluse.js', fail, { home });
  run('claude-posttooluse.js', fail, { home });
  const out = run('claude-posttooluse.js', fail, { home });
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /has failed 3 times in a row/);
});

test('Devin wrap mode: only known-noisy, stateless commands are wrapped', () => {
  const { handle, wrappable } = require('../hooks/devin-pretooluse');
  const pre = (command) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'dv-1', tool_name: 'exec', tool_input: { command } });
  const out = handle(pre('npm test -- --runInBand'), 'linux');
  const cmd = out.hookSpecificOutput.updatedInput.command;
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(cmd, /tokenarmy\.js" run --agent devin --session dv-1 --b64 /);
  assert.strictEqual(Buffer.from(cmd.split('--b64 ')[1].split(' ')[0], 'base64').toString(), 'npm test -- --runInBand', 'exact command preserved');
  assert.match(cmd, / # tokenarmy: npm test -- --runInBand$/, 'original command stays readable');
  for (const c of ['cd app && npm test', 'export CI=1; npm test', 'source .venv/bin/activate && pytest', 'npm test | tail -20', 'npm run dev &', 'vim README.md', 'echo hello', 'git log --oneline # raw', 'cat <<EOF > x\nhi\nEOF']) {
    assert.strictEqual(wrappable(c), false, c);
  }
  for (const c of ['pytest -v', 'npm install', 'git log', 'cargo build', 'docker build .', 'rg TODO src']) assert.strictEqual(wrappable(c), true, c);
  assert.strictEqual(handle(pre('npm test'), 'win32'), null, 'not on Windows');
  assert.strictEqual(handle(JSON.stringify({ tool_name: 'read', tool_input: { file_path: 'x' } }), 'linux'), null);
});

// ---------------------------------------------------------------- run --b64
test('run --b64 runs the exact command, keeps its exit code, and saves raw output for agents', () => {
  const home = fresh();
  const cmd = `node -e "console.log('a  b|c'); process.exit(3)"`;
  const r = spawnSync(process.execPath, [CLI, 'run', '--b64', Buffer.from(cmd).toString('base64')], { encoding: 'utf8', env: { ...process.env, TOKENARMY_HOME: home } });
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.stdout.trim(), 'a  b|c', 'quotes, spacing and pipes untouched; small output not compressed');
  const loud = `node -e "for(let i=0;i<300;i++)console.log('  ✓ test number '+i+' passes (2 ms)');console.log('Error: boom')"`;
  const r2 = spawnSync(process.execPath, [CLI, 'run', '--agent', 'devin', '--session', 's9', '--b64', Buffer.from(loud).toString('base64')], { encoding: 'utf8', env: { ...process.env, TOKENARMY_HOME: home } });
  assert.match(r2.stdout, /Error: boom/);
  assert.match(r2.stdout, /full output: .*\.log\]/);
  const e = ledger(home).at(-1);
  assert.strictEqual(e.kind, 'run:devin');
  assert.strictEqual(e.session, 's9');
});

// ---------------------------------------------------------------- lifecycle
test('Copilot/Devin lifecycle: session start and compaction reset re-read tracking; context reply formats', () => {
  const agents = require('../src/agents');
  assert.deepStrictEqual(agents.contextReply('copilot', 'SessionStart', 'hi'), { additionalContext: 'hi' });
  assert.deepStrictEqual(agents.contextReply('devin', 'SessionStart', 'hi'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' } });
  const home = fresh();
  const reads = path.join(home, 'sessions', 'cp-3', 'reads.json');
  for (const [payload, args] of [
    [{ sessionId: 'cp-3', cwd: os.tmpdir(), source: 'startup' }, ['--agent', 'copilot', '--event', 'sessionStart']],
    [{ sessionId: 'cp-3', cwd: os.tmpdir(), trigger: 'auto', transcriptPath: '/x' }, ['--agent', 'copilot', '--event', 'preCompact']],
    [{ hook_event_name: 'PostCompaction', session_id: 'cp-3', summary: null }, ['--agent', 'devin']],
  ]) {
    fs.mkdirSync(path.dirname(reads), { recursive: true });
    fs.writeFileSync(reads, '{}');
    run('claude-lifecycle.js', payload, { home, args });
    assert.ok(!fs.existsSync(reads), `reads reset for ${args.join(' ')}`);
  }
});

// ---------------------------------------------------------------- installers
test('init --agent copilot writes .github/hooks/tokenarmy.json in the documented format', () => {
  const dir = fresh();
  const r = spawnSync(process.execPath, [CLI, 'init', '--agent', 'copilot'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.github', 'hooks', 'tokenarmy.json'), 'utf8'));
  assert.strictEqual(cfg.version, 1);
  assert.deepStrictEqual(Object.keys(cfg.hooks).sort(), ['postToolUse', 'preCompact', 'sessionStart']);
  assert.strictEqual(cfg.hooks.postToolUse[0].matcher, 'bash|powershell|view|grep|rg');
  assert.match(cfg.hooks.postToolUse[0].command, /claude-posttooluse\.js" --agent copilot$/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'Claude settings untouched');
});

test('init --agent devin merges into .devin/hooks.v1.json and keeps other hooks', () => {
  const dir = fresh();
  fs.mkdirSync(path.join(dir, '.devin'));
  fs.writeFileSync(path.join(dir, '.devin', 'hooks.v1.json'), JSON.stringify({ PostToolUse: [{ matcher: '^edit$', hooks: [{ type: 'command', command: './fmt.sh' }] }] }));
  const r = spawnSync(process.execPath, [CLI, 'init', '--agent', 'devin', '--wrap'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.devin', 'hooks.v1.json'), 'utf8'));
  assert.strictEqual(cfg.PostToolUse.length, 2, 'existing hook kept');
  assert.strictEqual(cfg.PostToolUse[0].hooks[0].command, './fmt.sh');
  assert.ok(cfg.SessionStart && cfg.PostCompaction && cfg.PreToolUse);
  // Re-running without --wrap removes our PreToolUse entry and does not duplicate the rest.
  spawnSync(process.execPath, [CLI, 'init', '--agent', 'devin'], { cwd: dir, encoding: 'utf8' });
  const again = JSON.parse(fs.readFileSync(path.join(dir, '.devin', 'hooks.v1.json'), 'utf8'));
  assert.strictEqual(again.PostToolUse.length, 2);
  assert.ok(!again.PreToolUse);
});

test('the .claude/settings.json entry stands aside when Copilot has its own TokenArmy install', () => {
  const dir = fresh();
  const evt = copilotCamel('bash', { command: 'npm test' }, noisy, { cwd: dir });
  assert.ok(run('claude-posttooluse.js', evt, { cwd: dir }).modifiedResult, 'no dedicated install: the Claude entry serves Copilot');
  spawnSync(process.execPath, [CLI, 'init', '--agent', 'copilot'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(run('claude-posttooluse.js', evt, { cwd: dir }), null, 'dedicated install present: no double run');
  assert.ok(run('claude-posttooluse.js', evt, { cwd: dir, args: ['--agent', 'copilot'] }).modifiedResult, 'the dedicated entry still runs');
});
