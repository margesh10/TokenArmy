#!/usr/bin/env node
'use strict';
// Devin (CLI / Devin Local) PreToolUse hook: opt-in "wrap" mode.
//
// Devin's hooks can't replace a tool's output after it runs, but a PreToolUse hook may rewrite the
// tool's input (hookSpecificOutput.updatedInput). So for known-noisy shell commands only (tests,
// installs, builds, git log/diff/push, docker, searches) we run the exact same command through
// `tokenarmy run --b64 …`, which executes it unchanged in a shell, keeps the exit code, saves the
// raw output, and prints the compressed version.
//
// Deliberately conservative:
//   - never wraps commands that change shell state (cd, export, source, alias, …): Devin keeps a
//     persistent shell, and those must run in it, not in a child process;
//   - never wraps commands the agent already narrowed (| tail, | grep, …), backgrounded (&) or with
//     heredocs; never wraps on Windows (the shell Devin uses there isn't documented);
//   - opt out per command with `# raw`, or entirely with TOKENARMY_OFF=1.
const path = require('path');
const { detectFilter } = require('../src/filters');

const CLI = path.resolve(__dirname, '..', 'bin', 'tokenarmy.js').replace(/\\/g, '/');
const NARROWED = /\|\s*(head|tail|grep|rg|sed|awk|cut|sort|uniq|wc|jq|less|more)\b|\bsed\s+-n\b/i;
const STATEFUL = /(^|[;&|(]\s*)(cd|pushd|popd|export|unset|source|\.|alias|unalias|set|eval|exec|ulimit|umask|nvm|conda|pyenv|rbenv|workon|deactivate|activate)(\s|$)/;
const SEARCH = /^\s*(grep|egrep|rg|ag|git\s+grep)\b/;
const INTERACTIVE = /\b(vim?|nano|emacs|less|more|top|htop|watch|ssh|tmux|screen)\b|--watch\b|\s-it?\s/;

function wrappable(cmd) {
  if (!cmd || /#\s*raw\b/.test(cmd) || cmd.includes(CLI) || /\btokenarmy\s+run\b/.test(cmd)) return false;
  if (NARROWED.test(cmd) || STATEFUL.test(cmd) || INTERACTIVE.test(cmd)) return false;
  if (/<<|&\s*$|\$\(\s*$/.test(cmd)) return false;
  return !!(detectFilter(cmd) || SEARCH.test(cmd));
}

function handle(raw, platform = process.platform) {
  if (process.env.TOKENARMY_OFF === '1') return null;
  if (platform === 'win32' && process.env.TOKENARMY_DEVIN_WRAP !== 'force') return null;
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return null;
  }
  if (evt.tool_name !== 'exec') return null;
  const cmd = evt.tool_input && typeof evt.tool_input.command === 'string' ? evt.tool_input.command : '';
  if (!wrappable(cmd)) return null;
  const b64 = Buffer.from(cmd, 'utf8').toString('base64');
  const sid = evt.session_id ? ` --session ${String(evt.session_id).replace(/[^\w-]/g, '')}` : '';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: `node "${CLI}" run --agent devin${sid} --b64 ${b64}` } } };
}

module.exports = { handle, wrappable };

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (buf += d));
  process.stdin.on('end', () => {
    try {
      const out = handle(buf);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {
      /* a hook must never break the agent */
    }
  });
}
