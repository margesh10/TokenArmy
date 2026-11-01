'use strict';
// `tokenarmy audit` — find where a project / agent setup leaks tokens.
// Everything here is static analysis of local files; nothing is uploaded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { estimateTokens } = require('./tokens');
const { score } = require('./slop');
const { walk } = require('./context');

const MEMORY_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', '.github/copilot-instructions.md'];
const VOLATILE = /\b(20\d\d-\d\d-\d\d[T ]\d\d:\d\d|last updated:?\s*\d|today is|current (date|time)|session id|uuid:?\s*[0-9a-f]{8}-)/i;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function audit(root = process.cwd()) {
  const findings = [];
  const add = (severity, area, title, detail, fix, tokens = 0) => findings.push({ severity, area, title, detail, fix, tokens });

  // 1. Always-loaded memory files: billed on EVERY request.
  let memoryTokens = 0;
  const home = os.homedir();
  const memPaths = [...MEMORY_FILES.map((f) => path.join(root, f)), path.join(home, '.claude', 'CLAUDE.md')];
  for (const p of memPaths) {
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    const t = estimateTokens(txt);
    memoryTokens += t;
    const sl = score(txt);
    const rel = p.startsWith(home) && !p.startsWith(root) ? '~' + p.slice(home.length) : path.relative(root, p) || p;
    if (t > 2500) add('high', 'memory', `${rel} is ~${t} tokens`, 'Loaded into every request of every session.', `Move rarely-needed sections into skills or docs/ and link them; run \`tokenarmy compress ${rel} --level 2\`. Target < 1500 tokens.`, t - 1500);
    else if (t > 1500) add('medium', 'memory', `${rel} is ~${t} tokens`, 'Loaded into every request.', 'Trim to rules the agent cannot infer from the code.', t - 1500);
    if (sl.per100words >= 1.5) add('medium', 'memory', `${rel} slop score ${sl.per100words}/100 words (${sl.verdict})`, `Top markers: ${sl.hits.slice(0, 5).map((h) => h.marker).join(', ')}`, `tokenarmy slop ${rel} --fix`, Math.round(t * 0.08));
    if (VOLATILE.test(txt)) add('high', 'cache', `${rel} contains volatile text (dates/ids)`, 'Anything that changes between sessions near the top of the prompt breaks prompt caching, turning ~0.1× cached reads into full-price input.', 'Remove timestamps/ids from always-loaded files; put dynamic info in the user turn.', 0);
  }

  // 2. MCP servers: tool schemas are resent every turn.
  const mcpSources = [path.join(root, '.mcp.json'), path.join(home, '.claude.json'), path.join(root, '.cursor', 'mcp.json'), path.join(home, '.codex', 'config.json')];
  const servers = new Set();
  for (const p of mcpSources) {
    const j = readJson(p);
    if (!j) continue;
    for (const k of Object.keys(j.mcpServers || {})) servers.add(k);
    if (j.projects && j.projects[root] && j.projects[root].mcpServers) for (const k of Object.keys(j.projects[root].mcpServers)) servers.add(k);
  }
  if (servers.size >= 4) add('high', 'mcp', `${servers.size} MCP servers configured`, `Servers: ${[...servers].join(', ')}. Large servers (GitHub, Playwright) can add 10k-40k tokens of tool schemas each when not lazily loaded.`, 'Disable servers per-project you do not use there; prefer CLIs (gh, psql) the agent already knows; keep tool search / deferred loading on.', servers.size * 3000);
  else if (servers.size) add('info', 'mcp', `${servers.size} MCP server(s): ${[...servers].join(', ')}`, 'Fine if each is used in this project.', 'Run /context in Claude Code to see the real per-server cost.', 0);

  // 3. Skills / agents descriptions (loaded each session).
  for (const dir of [path.join(root, '.claude', 'skills'), path.join(home, '.claude', 'skills')]) {
    if (!fs.existsSync(dir)) continue;
    const skills = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'SKILL.md')));
    let descTokens = 0;
    for (const s of skills) {
      const fm = (fs.readFileSync(path.join(dir, s, 'SKILL.md'), 'utf8').match(/^---[\s\S]*?---/) || [''])[0];
      descTokens += estimateTokens(fm);
    }
    if (descTokens > 1500) add('medium', 'skills', `${skills.length} skills, ~${descTokens} tokens of descriptions`, 'Every skill description is in context every session.', 'Shorten descriptions to one trigger sentence; uninstall skills you have not used this month.', descTokens - 1500);
  }

  // 4. Big files an agent is likely to read whole.
  const files = walk(root, /\.(js|ts|tsx|jsx|py|go|rs|java|cs|rb|php|json|md|ya?ml|txt|csv|log|lock|sql|html|css)$/i, [], 4000);
  const big = [];
  for (const f of files) {
    let size = 0;
    try {
      size = fs.statSync(f).size;
    } catch {
      continue;
    }
    if (size > 60_000) big.push({ f: path.relative(root, f), t: Math.round(size / 3.6) });
  }
  big.sort((a, b) => b.t - a.t);
  if (big.length) {
    const top = big.slice(0, 8);
    add('medium', 'files', `${big.length} files over ~16k tokens`, top.map((b) => `${b.f} (~${b.t} tok)`).join('\n'), 'Add deny rules for generated/lock/log files (see templates/settings.json); read with offsets or `tokenarmy outline <file>` instead of whole files.', 0);
  }
  const lockOrGen = files.filter((f) => /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|\.min\.(js|css)|\.map|\.log)$/i.test(f));
  const settings = readJson(path.join(root, '.claude', 'settings.json')) || {};
  const deny = ((settings.permissions || {}).deny || []).join(' ');
  if (lockOrGen.length && !/lock|\.log|min\./i.test(deny)) add('medium', 'files', `${lockOrGen.length} lock/minified/log files with no Read deny rule`, lockOrGen.slice(0, 5).map((f) => path.relative(root, f)).join(', '), 'Copy the deny list from templates/settings.json into .claude/settings.json.', 0);

  // 5. Hooks: is output compression wired?
  const allHooks = JSON.stringify([settings.hooks, (readJson(path.join(home, '.claude', 'settings.json')) || {}).hooks]);
  if (!/tokenarmy|posttooluse/i.test(allHooks)) add('high', 'hooks', 'No tool-output compression hook installed', 'Shell output (tests, installs, builds, git) is usually the single largest input-token sink in agent loops: it is appended to history and resent on every following turn.', 'tokenarmy init  (adds a PostToolUse hook that compresses Bash output; it never rewrites or auto-approves commands)', 0);

  const order = { high: 0, medium: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.tokens - a.tokens);
  return { root, memoryTokens, mcpServers: [...servers], findings, perTurnSavings: findings.reduce((a, f) => a + (f.tokens || 0), 0) };
}

module.exports = { audit };
