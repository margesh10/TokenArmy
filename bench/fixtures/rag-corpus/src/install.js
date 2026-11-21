'use strict';
// Install TokenArmy's hooks for GitHub Copilot and Devin (Claude Code is handled by `init` itself).
// Each writes the agent's own documented hook file, keeps whatever else is in it, and replaces
// any older TokenArmy entries.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const js = (f) => path.join(ROOT, 'hooks', f).replace(/\\/g, '/');
const OURS = /tokenarmy|claude-posttooluse\.js|claude-lifecycle\.js|devin-pretooluse\.js/i;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------- GitHub Copilot
// VS Code agent mode + Copilot CLI read .github/hooks/*.json (repo) and ~/.copilot/hooks/*.json (user).
function copilotFile({ global, cwd }) {
  const home = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  return global ? path.join(home, 'hooks', 'tokenarmy.json') : path.join(cwd, '.github', 'hooks', 'tokenarmy.json');
}

function copilotConfig() {
  const entry = (command, extra = {}) => ({ type: 'command', command, timeoutSec: 10, ...extra });
  return {
    version: 1,
    hooks: {
      sessionStart: [entry(`node "${js('claude-lifecycle.js')}" --agent copilot --event sessionStart`)],
      preCompact: [entry(`node "${js('claude-lifecycle.js')}" --agent copilot --event preCompact`)],
      postToolUse: [entry(`node "${js('claude-posttooluse.js')}" --agent copilot`, { matcher: 'bash|powershell|view|grep|rg' })],
    },
  };
}

function installCopilot({ global = false, cwd = process.cwd() } = {}) {
  const file = copilotFile({ global, cwd });
  writeJson(file, copilotConfig()); // this file is ours alone
  return { file, notes: global ? [] : ['This file holds absolute paths to TokenArmy on this machine; keep it out of git (or use --global) so teammates are not affected.'] };
}

// ---------------------------------------------------------------- Devin
// Devin CLI / Devin Local: project .devin/hooks.v1.json (the file IS the hooks object),
// user ~/.config/devin/config.json ("hooks" key; %APPDATA%\devin on Windows).
function devinFile({ global, cwd }) {
  if (!global) return path.join(cwd, '.devin', 'hooks.v1.json');
  const base = process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'devin') : path.join(os.homedir(), '.config', 'devin');
  return path.join(base, 'config.json');
}

function devinHooks({ wrap }) {
  const h = (command) => [{ type: 'command', command, timeout: 10 }];
  const hooks = {
    SessionStart: [{ hooks: h(`node "${js('claude-lifecycle.js')}" --agent devin`) }],
    PostCompaction: [{ hooks: h(`node "${js('claude-lifecycle.js')}" --agent devin --event PostCompaction`) }],
    PostToolUse: [{ matcher: '^exec$', hooks: h(`node "${js('claude-posttooluse.js')}" --agent devin`) }],
  };
  if (wrap) hooks.PreToolUse = [{ matcher: '^exec$', hooks: h(`node "${js('devin-pretooluse.js')}"`) }];
  return hooks;
}

function mergeHooks(existing, ours) {
  const out = { ...(existing || {}) };
  for (const [event, entries] of Object.entries(ours)) {
    const cur = Array.isArray(out[event]) ? out[event].filter((e) => !OURS.test(JSON.stringify(e))) : [];
    out[event] = [...cur, ...entries];
  }
  // Drop our PreToolUse wrapper if wrap mode is now off.
  if (!ours.PreToolUse && Array.isArray(out.PreToolUse)) {
    out.PreToolUse = out.PreToolUse.filter((e) => !OURS.test(JSON.stringify(e)));
    if (!out.PreToolUse.length) delete out.PreToolUse;
  }
  return out;
}

function installDevin({ global = false, cwd = process.cwd(), wrap = false } = {}) {
  const file = devinFile({ global, cwd });
  const cur = readJson(file);
  const ours = devinHooks({ wrap });
  if (global) writeJson(file, { ...(cur || {}), hooks: mergeHooks(cur && cur.hooks, ours) });
  else writeJson(file, mergeHooks(cur, ours));
  const notes = [];
  if (wrap && process.platform === 'win32') notes.push('Wrap mode is skipped on Windows (Devin does not document which shell it uses there); it is active on macOS, Linux and WSL.');
  if (!wrap) notes.push('Devin hooks cannot replace a tool\'s output, so without --wrap TokenArmy adds the project brief, learned facts and the loop guard, but does not shrink command output. Add --wrap to run known-noisy commands through `tokenarmy run`.');
  return { file, notes };
}

// Is there a dedicated TokenArmy install for this agent? The Claude-format entry (.claude/settings.json,
// which Copilot and Devin also read) stands aside when there is, so nothing runs twice.
function hasDedicatedInstall(agent, cwd) {
  const has = (f) => {
    try {
      return OURS.test(fs.readFileSync(f, 'utf8'));
    } catch {
      return false;
    }
  };
  const dir = cwd || process.cwd();
  if (agent === 'copilot') return has(copilotFile({ global: false, cwd: dir })) || has(copilotFile({ global: true }));
  if (agent === 'devin') return has(devinFile({ global: false, cwd: dir })) || has(devinFile({ global: true }));
  return false;
}

module.exports = { installCopilot, installDevin, copilotConfig, devinHooks, mergeHooks, hasDedicatedInstall, copilotFile, devinFile };
