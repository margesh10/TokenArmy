#!/usr/bin/env node
'use strict';
// Claude Code PostToolUse hook: compress Bash output before Claude sees it.
//
// Why PostToolUse (and not command rewriting like rtk's PreToolUse hook)?
//   - The command the user approved is exactly the command that runs.
//   - We never return permissionDecision:"allow", so no permission prompt is bypassed.
//   - The full raw output is saved to ~/.tokenarmy/raw/ and its path is shown,
//     so compression is recoverable: Claude can Read the raw log when it needs it.
//
// Opt out per command by adding the comment `# raw` to it, or globally with TOKENARMY_OFF=1.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { squeeze } = require('../src/squeeze');
const { estimateTokens } = require('../src/tokens');
const stats = require('../src/stats');

const MIN_TOKENS = +(process.env.TOKENARMY_MIN_TOKENS || 300); // don't touch small outputs
const MIN_GAIN = +(process.env.TOKENARMY_MIN_GAIN || 0.2); // need ≥20% saving to bother
const MAX_LINES = +(process.env.TOKENARMY_MAX_LINES || 120);

function main(raw) {
  if (process.env.TOKENARMY_OFF === '1') return;
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  if (evt.tool_name !== 'Bash') return;
  const cmd = (evt.tool_input && evt.tool_input.command) || '';
  if (/#\s*raw\b/.test(cmd)) return;
  const res = evt.tool_response || {};
  if (res.isImage || typeof res.stdout !== 'string') return;

  const stdout = res.stdout;
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  const before = estimateTokens(stdout) + estimateTokens(stderr);
  if (before < MIN_TOKENS) return;

  const newOut = squeeze(stdout, { command: cmd, maxLines: MAX_LINES });
  const newErr = stderr ? squeeze(stderr, { command: '', maxLines: Math.max(40, MAX_LINES / 2) }) : '';
  const after = estimateTokens(newOut) + estimateTokens(newErr);
  if (before - after < before * MIN_GAIN) return;

  // Save the raw output so nothing is truly lost.
  let rawPath = '';
  try {
    const dir = path.join(path.dirname(stats.FILE), 'raw');
    fs.mkdirSync(dir, { recursive: true });
    rawPath = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.log`);
    fs.writeFileSync(rawPath, `$ ${cmd}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  } catch {
    rawPath = '';
  }
  const note = `\n[tokenarmy: ~${before}→~${after} tokens${rawPath ? `; full output: ${rawPath}` : ''}]`;

  stats.record({ kind: 'hook:bash', cmd: cmd.slice(0, 80), before, after });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: { ...res, stdout: newOut + note, stderr: newErr },
      },
    })
  );
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
