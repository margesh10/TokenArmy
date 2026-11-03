#!/usr/bin/env node
'use strict';
// Claude Code PostToolUse hook. Shrinks tool results before Claude sees them:
//   Bash / PowerShell  noisy command output -> errors, failures, summaries (built-in + learned filters)
//   Grep               long match lists -> grouped by file with counts
//   Read               re-reading an unchanged file -> a short note; a changed file -> just the diff
//
// Why PostToolUse (and not rewriting commands in a PreToolUse hook)?
//   - The command the user approved is exactly the command that runs.
//   - We never return permissionDecision, so no permission prompt is bypassed.
//   - Raw output is saved to ~/.tokenarmy/raw/ and its path is shown, so nothing is lost.
//
// It also learns: opening a raw log means a compression hid something needed. Command families
// that keep getting expanded are automatically left alone (see src/learn.js).
//
// Opt out: add `# raw` to a command, TOKENARMY_OFF=1 (everything), TOKENARMY_READ_DEDUPE=0,
// TOKENARMY_SEARCH=0, or list commands under "bypass" in ~/.tokenarmy/filters.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { squeeze, stripAnsi, collapseCarriageReturns, squashBlankLines } = require('../src/squeeze');
const { estimateTokens } = require('../src/tokens');
const { compressSearch } = require('../src/search');
const { crushJson } = require('../src/json');
const { SIGNAL } = require('../src/squeeze-signal');
const { diffLines } = require('../src/diff');
const stats = require('../src/stats');
const session = require('../src/session');
const learn = require('../src/learn');
const facts = require('../src/facts');
const { redact } = require('../src/redact');
const brief = require('../src/brief');

const env = process.env;
const MIN_TOKENS = +(env.TOKENARMY_MIN_TOKENS || 300); // don't touch small outputs
const MIN_GAIN = +(env.TOKENARMY_MIN_GAIN || 0.2); // need >= 20% saving to bother
const MAX_LINES = +(env.TOKENARMY_MAX_LINES || 120);
const READ_MIN_TOKENS = +(env.TOKENARMY_READ_MIN_TOKENS || 200);
const READ_TTL_MS = +(env.TOKENARMY_READ_TTL_MIN || 20) * 60 * 1000; // older reads may have left context

// The agent already chose what to look at: only lossless cleanup, never cut lines.
const NARROWED = /\|\s*(head|tail|grep|rg|sed|awk|cut|sort|uniq|wc|jq|Select-Object|Select-String|findstr|Where-Object|Measure-Object)\b|\bsed\s+-n\b|\b(head|tail)\s+-n?\s*\d+/i;
const SEARCH_CMD = /^\s*(grep|egrep|rg|ag|ack|git\s+grep|Select-String|sls|findstr)\b/i;

function saveRaw(label, body) {
  try {
    const dir = path.join(path.dirname(stats.FILE), 'raw');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.log`);
    fs.writeFileSync(p, redact(`$ ${label}\n--- stdout ---\n${body}`));
    return p;
  } catch {
    return '';
  }
}

const note = (before, after, rawPath) => `\n[tokenarmy: ~${before}→~${after} tokens${rawPath ? `; full output: ${rawPath}` : ''}]`;
const gainOk = (before, after) => before - after >= before * MIN_GAIN;
const emit = (updatedToolOutput) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } }));

function lossless(text) {
  return squashBlankLines(collapseCarriageReturns(stripAnsi(text).replace(/\r\n/g, '\n')).split('\n')).join('\n');
}

// Loop guard: the same command failing with the same error again and again burns tokens.
// From the 3rd identical failure in a session, say so (the output itself is left intact).
function loopNote(evt, cmd, text) {
  if (env.TOKENARMY_LOOPGUARD === '0' || !evt.session_id) return '';
  const fam = learn.family(cmd);
  const loops = session.load(evt.session_id, 'loops.json', {});
  const first = text.split('\n').find((l) => SIGNAL.test(l) && !/\b(0 (failed|errors?)|no errors?|passed)\b/i.test(l));
  if (!first) {
    if (loops[fam]) {
      delete loops[fam];
      session.save(evt.session_id, 'loops.json', loops);
    }
    return '';
  }
  const sig = first.trim().replace(/\d+(\.\d+)?/g, '#').replace(/0x[0-9a-f]+/gi, 'H').slice(0, 160);
  const cur = loops[fam] && loops[fam].sig === sig ? loops[fam] : { sig, n: 0 };
  cur.n++;
  loops[fam] = cur;
  session.save(evt.session_id, 'loops.json', loops);
  // Speak at the 3rd repeat, then only every 3rd after that: a note on every retry is itself noise.
  if (cur.n < 3 || cur.n % 3 !== 0) return '';
  stats.record({ kind: 'loop', family: fam, session: evt.session_id, cmd: cmd.slice(0, 80), before: 0, after: 0, repeats: cur.n });
  // Mirror the agent's own actions back and redirect; never tell it to stop (TokenEconomizer's loop-guard rule).
  return `\n[tokenarmy] \`${fam}\` has failed ${cur.n} times in a row with the same error ("${first.trim().slice(0, 120)}"). Another run without a different change will fail the same way. Keep going, but test a materially different hypothesis: re-read what the failing check expects, and consider a different file or root cause than the one you have been changing.`;
}

function shell(evt, res) {
  const cmd = (evt.tool_input && evt.tool_input.command) || '';
  if (/#\s*raw\b/.test(cmd)) return;
  if (res.isImage || typeof res.stdout !== 'string') return;
  const stdout = res.stdout;
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  const loop = loopNote(evt, cmd, `${stdout}\n${stderr}`);
  facts.observe(evt, cmd, `${stdout}\n${stderr}`);
  brief.observeCommand(evt, cmd, `${stdout}\n${stderr}`);
  const before = estimateTokens(stdout) + estimateTokens(stderr);
  if (before < MIN_TOKENS) {
    if (loop) emit({ ...res, stdout: stdout + loop });
    return;
  }

  const fam = learn.family(cmd);
  const filters = learn.loadFilters(evt.cwd);
  const learned = learn.autoBypassed(stats.readRows());
  const hands_off = NARROWED.test(cmd) || learn.isBypassed(cmd, filters) || learned.bypass.has(fam);

  let newOut;
  let mode;
  if (hands_off) {
    newOut = lossless(stdout);
    mode = 'lossless';
  } else {
    const ruled = learn.applyUserRules(cmd, stdout, filters);
    const json = env.TOKENARMY_JSON !== '0' ? crushJson(ruled.output) : null;
    const searched = !json && SEARCH_CMD.test(cmd) && env.TOKENARMY_SEARCH !== '0' ? compressSearch(lossless(ruled.output)) : null;
    newOut = json || searched || squeeze(ruled.output, { command: cmd, maxLines: MAX_LINES });
    mode = json ? 'json' : searched ? 'search' : ruled.applied ? 'rules' : 'squeeze';
  }
  const newErr = stderr ? (hands_off ? lossless(stderr) : squeeze(stderr, { command: '', maxLines: Math.max(40, MAX_LINES / 2) })) : '';
  const after = estimateTokens(newOut) + estimateTokens(newErr);
  if (!gainOk(before, after)) {
    if (loop) emit({ ...res, stdout: stdout + loop });
    return;
  }

  const rawPath = saveRaw(cmd, `${stdout}\n--- stderr ---\n${stderr}`);
  stats.record({
    kind: evt.tool_name === 'PowerShell' ? 'hook:powershell' : 'hook:bash',
    mode,
    family: fam,
    session: evt.session_id || undefined,
    cmd: cmd.slice(0, 80),
    before,
    after,
  });
  emit({ ...res, stdout: newOut + note(before, after, rawPath) + loop, stderr: newErr });
}

function grep(evt, res) {
  if (env.TOKENARMY_SEARCH === '0' || res.mode !== 'content' || typeof res.content !== 'string') return;
  const before = estimateTokens(res.content);
  if (before < MIN_TOKENS) return;
  const out = compressSearch(res.content);
  if (!out) return;
  const after = estimateTokens(out);
  if (!gainOk(before, after)) return;
  const label = `Grep ${(evt.tool_input && evt.tool_input.pattern) || ''}`;
  const rawPath = saveRaw(label, res.content);
  stats.record({ kind: 'hook:grep', mode: 'search', family: 'grep-tool', session: evt.session_id || undefined, cmd: label.slice(0, 80), before, after });
  emit({ ...res, content: out + note(before, after, rawPath) });
}

function read(evt, res) {
  const file = res.file;
  if (res.type !== 'text' || !file || typeof file.content !== 'string') return;
  brief.observeRead(evt, file.filePath);
  if (env.TOKENARMY_READ_DEDUPE === '0') return;
  const input = evt.tool_input || {};
  const content = file.content;
  const tokens = estimateTokens(content);
  const sid = evt.session_id;
  if (!sid) return;
  // Same file + same range + same agent; subagents have their own context.
  const key = [file.filePath, input.offset || '', input.limit || '', evt.agent_id || ''].join('|');
  const reads = session.load(sid, 'reads.json', {});
  const prev = reads[key];
  const h = session.hash(content);
  const now = Date.now();
  reads[key] = { hash: h, at: now };
  session.save(sid, 'reads.json', reads);
  session.save(sid, `read-${h}.json`, content);
  if (!prev || tokens < READ_MIN_TOKENS || now - prev.at > READ_TTL_MS) return;

  const howFull = 'If you no longer have it in context, Read again with an explicit `limit` (e.g. limit: 100000) to get the full file.';
  let replacement;
  let kind;
  if (prev.hash === h) {
    replacement = `[tokenarmy] Unchanged since you read it ${Math.round((now - prev.at) / 60000)} min ago in this session (${file.numLines} lines, identical content). Your earlier read is still in context. ${howFull}`;
    kind = 'hook:read-same';
  } else {
    const old = session.load(sid, `read-${prev.hash}.json`, null);
    if (typeof old !== 'string') return;
    const d = diffLines(old, content);
    if (!d || !d.text || estimateTokens(d.text) > tokens * 0.6) return; // big rewrite: show it all
    replacement = `[tokenarmy] Changed since your earlier read in this session. Showing only the diff (${d.changes} changed lines; "+" added, "-" removed; line numbers are in the new file). ${howFull}\n${d.text}`;
    kind = 'hook:read-diff';
  }
  const after = estimateTokens(replacement);
  if (!gainOk(tokens, after)) return;
  stats.record({ kind, family: 'read', session: sid, cmd: `Read ${path.basename(file.filePath)}`, before: tokens, after });
  emit({ ...res, file: { ...file, content: replacement, numLines: replacement.split('\n').length } });
}

function main(raw) {
  if (env.TOKENARMY_OFF === '1') return;
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  const res = evt.tool_response;
  if (!res || typeof res !== 'object') return;

  // Opening one of our raw logs = the compression hid something. Record it, never compress it.
  const expanded = learn.expandTarget(evt.tool_name, evt.tool_input);
  if (expanded) {
    stats.record({ kind: 'expand', family: learn.family(expanded), session: evt.session_id || undefined, cmd: expanded.slice(0, 80), before: 0, after: 0 });
    return;
  }

  if (evt.tool_name === 'Bash' || evt.tool_name === 'PowerShell') return shell(evt, res);
  if (evt.tool_name === 'Grep') return grep(evt, res);
  if (evt.tool_name === 'Read') return read(evt, res);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  try {
    main(buf);
  } catch {
    /* a hook must never break the agent */
  }
});
