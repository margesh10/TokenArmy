#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { estimateTokens, formatTokens, savings } = require('../src/tokens');
const { squeeze } = require('../src/squeeze');
const slop = require('../src/slop');
const prompt = require('../src/prompt');
const ctx = require('../src/context');
const { audit } = require('../src/audit');
const stats = require('../src/stats');

const VERSION = require('../package.json').version;
const HELP = `TokenArmy v${VERSION} — save tokens everywhere. By Margesh.

Usage: tokenarmy <command> [args]

  count [file|-]                     Estimate tokens (stdin if no file)
  squeeze [file|-] [--cmd "git log"] Compress tool/command output
  run -- <command...>                Run a command, print compressed output (any agent)
  slop <file|-> [--fix] [--json]     Score AI slop per 100 words; --fix rewrites it
  compress <file> [--level 1|2|3] [--write]
                                     Compress prompts / CLAUDE.md / AGENTS.md
  outline <file>                     Signatures-only skeleton of a code file
  pack <dir> --query "..." [--budget 4000]
                                     BM25 + MMR retrieval packed under a token budget
  graph <dir> --seed <file> [--hops 2]
                                     Files related to <file> via imports (graph-RAG)
  audit [dir] [--json]               Find where this project/agent setup wastes tokens
  init [--global] [--skill] [--statusline]
                                     Install the Claude Code hooks (+ terse skill,
                                     + status line showing context, $ and tokens saved)
  gain                               Local savings ledger
  expand [id|path]                   Print a saved raw output (latest if no id)
  learn [--write]                    What it learned: auto-bypassed commands, proposed noise filters
  ab <config.json> [--out dir]       Controlled A/B benchmark on a real task (on vs off, billed tokens)
  statusline                         Status line renderer (reads Claude Code's JSON on stdin)
  help | version
`;

function args(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      flags['--'] = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

function readInput(file) {
  if (!file || file === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(file, 'utf8');
}

function report(kind, before, after) {
  const s = savings(before, after);
  stats.record({ kind, before: s.before, after: s.after });
  process.stderr.write(`[tokenarmy] ${formatTokens(s.before)} → ${formatTokens(s.after)} tokens (−${s.pct}%)\n`);
}

const commands = {
  count({ pos }) {
    const t = readInput(pos[0]);
    console.log(`${estimateTokens(t)} tokens (estimate), ${t.length} chars, ${t.split('\n').length} lines`);
  },

  squeeze({ pos, flags }) {
    const t = readInput(pos[0]);
    const out = squeeze(t, { command: flags.cmd || '', maxLines: +(flags['max-lines'] || 120) });
    process.stdout.write(out + '\n');
    report('squeeze', t, out);
  },

  run({ flags }) {
    const cmd = flags['--'];
    if (!cmd || !cmd.length) throw new Error('usage: tokenarmy run -- <command...>');
    const line = cmd.join(' ');
    const r = spawnSync(line, { shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const raw = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
    const out = squeeze(raw, { command: line });
    process.stdout.write(out + '\n');
    report('run', raw, out);
    process.exitCode = r.status == null ? 1 : r.status;
  },

  slop({ pos, flags }) {
    const t = readInput(pos[0]);
    if (flags.fix) {
      const fixed = slop.deslop(t);
      if (pos[0] && pos[0] !== '-' && flags.write) fs.writeFileSync(pos[0], fixed);
      else process.stdout.write(fixed + '\n');
      report('slop', t, fixed);
      return;
    }
    const s = slop.score(t);
    if (flags.json) return console.log(JSON.stringify(s, null, 2));
    console.log(`slop: ${s.per100words} markers / 100 words → ${s.verdict} (${s.markers} markers in ${s.words} words)`);
    for (const h of s.hits.slice(0, 12)) console.log(`  ${String(h.count).padStart(3)}× ${h.marker}`);
    if (s.markers) console.log('fix: tokenarmy slop <file> --fix [--write]');
  },

  compress({ pos, flags }) {
    const t = readInput(pos[0]);
    const out = prompt.compress(t, +(flags.level || 2));
    if (flags.write && pos[0] && pos[0] !== '-') {
      fs.writeFileSync(pos[0] + '.bak', t);
      fs.writeFileSync(pos[0], out);
      process.stderr.write(`[tokenarmy] wrote ${pos[0]} (backup: ${pos[0]}.bak)\n`);
    } else process.stdout.write(out);
    report('compress', t, out);
  },

  outline({ pos }) {
    const t = readInput(pos[0]);
    const out = ctx.outline(t, pos[0] || '');
    process.stdout.write(out + '\n');
    report('outline', t, out);
  },

  pack({ pos, flags }) {
    const dir = pos[0] || '.';
    if (!flags.query) throw new Error('usage: tokenarmy pack <dir> --query "..." [--budget 4000]');
    const files = ctx.walk(path.resolve(dir), /\.(md|mdx|txt|rst|js|ts|tsx|jsx|py|go|rs|java|cs|rb|php|ya?ml|toml|sql)$/i);
    const chunks = [];
    let all = 0;
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      all += estimateTokens(t);
      chunks.push(...ctx.chunk(t, { source: path.relative(process.cwd(), f) }));
    }
    const res = ctx.pack(chunks, flags.query, +(flags.budget || 4000));
    process.stdout.write(res.text + '\n');
    stats.record({ kind: 'pack', before: all, after: res.used });
    process.stderr.write(`[tokenarmy] ${res.chunks}/${res.considered} chunks, ~${res.used} tokens (corpus ~${formatTokens(all)})\n`);
  },

  graph({ pos, flags }) {
    const dir = path.resolve(pos[0] || '.');
    if (!flags.seed) throw new Error('usage: tokenarmy graph <dir> --seed <file> [--hops 2]');
    const files = ctx.walk(dir, /\.(js|ts|tsx|jsx|mjs|cjs|py)$/i);
    const g = ctx.buildGraph(files);
    const seed = path.resolve(flags.seed);
    for (const { file, hops } of ctx.neighbourhood(g, seed, +(flags.hops || 2))) console.log(`${hops}  ${path.relative(process.cwd(), file)}`);
  },

  audit({ pos, flags }) {
    const r = audit(path.resolve(pos[0] || '.'));
    if (flags.json) return console.log(JSON.stringify(r, null, 2));
    console.log(`TokenArmy audit — ${r.root}`);
    console.log(`always-loaded memory files: ~${r.memoryTokens} tokens/request · MCP servers: ${r.mcpServers.length}`);
    if (!r.findings.length) return console.log('No leaks found. 🫡');
    for (const f of r.findings) {
      console.log(`\n[${f.severity.toUpperCase()}] (${f.area}) ${f.title}`);
      if (f.detail) console.log('  ' + f.detail.split('\n').join('\n  '));
      console.log('  fix: ' + f.fix);
    }
    if (r.perTurnSavings) console.log(`\nEstimated recoverable: ~${formatTokens(r.perTurnSavings)} tokens per request.`);
  },

  init({ flags }) {
    const base = flags.global ? path.join(os.homedir(), '.claude') : path.join(process.cwd(), '.claude');
    const file = path.join(base, 'settings.json');
    fs.mkdirSync(base, { recursive: true });
    let s = {};
    if (fs.existsSync(file)) {
      s = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file + '.bak', JSON.stringify(s, null, 2));
    }
    // Replace any older TokenArmy entries (e.g. a Bash-only matcher) with the current set; keep everything else.
    const ours = (entry) => /claude-(posttooluse|lifecycle)\.js/.test(JSON.stringify(entry));
    s.hooks = s.hooks || {};
    let upgraded = false;
    for (const [event, entries] of Object.entries(require('../src/ab').hooksSettings().hooks)) {
      const cur = s.hooks[event] || [];
      if (cur.some(ours)) upgraded = true;
      s.hooks[event] = [...cur.filter((e) => !ours(e)), ...entries];
    }
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
    console.log(`${upgraded ? 'Updated' : 'Installed'} TokenArmy hooks in ${file}`);
    console.log('  PostToolUse  Bash/PowerShell output, Grep results, Read re-reads');
    console.log('  PreCompact + SessionStart  checkpoint that survives compaction');
    if (flags.statusline) {
      const cli = path.resolve(__filename).replace(/\\/g, '/');
      const want = { type: 'command', command: `node "${cli}" statusline`, padding: 0 };
      if (s.statusLine && !String(s.statusLine.command || '').includes('tokenarmy')) {
        console.log(`Left your existing statusLine alone (${s.statusLine.command}). Remove it and re-run to use TokenArmy's.`);
      } else {
        s.statusLine = want;
        fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
        console.log(`Installed status line in ${file}`);
      }
    }
    if (flags.skill) {
      const dst = path.join(base, 'skills', 'tokenarmy');
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'skills', 'tokenarmy', 'SKILL.md'), path.join(dst, 'SKILL.md'));
      console.log(`Installed skill → ${dst}`);
    }
    console.log('Restart Claude Code to load it. Disable anytime with TOKENARMY_OFF=1 or add "# raw" to a command.');
  },

  statusline() {
    // Must never throw or print junk: Claude Code shows whatever we write.
    let input = {};
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}');
    } catch {
      /* no/invalid stdin: render with defaults */
    }
    process.stdout.write(require('../src/statusline').render(input) + '\n');
  },

  gain() {
    const s = stats.summary();
    if (!s.events) return console.log('No savings recorded yet.');
    console.log(`${s.events} events · ${formatTokens(s.before)} → ${formatTokens(s.after)} tokens · saved ${formatTokens(s.saved)} (−${s.pct}%)`);
    for (const [k, v] of Object.entries(s.byKind)) console.log(`  ${k.padEnd(16)} ${String(v.events).padStart(5)} events  saved ${formatTokens(v.saved)}`);
    if (s.expands) console.log(`  raw logs opened by the agent: ${s.expands} (see \`tokenarmy learn\`)`);
    if (s.checkpoints) console.log(`  checkpoints restored after compaction: ${s.checkpoints}`);
    if (s.loops) console.log(`  repeated-failure warnings (loop guard): ${s.loops}`);
    console.log(`ledger: ${s.file}`);
  },

  // Print a saved raw output: by path, by id prefix, or the latest one.
  expand({ pos }) {
    const learn = require('../src/learn');
    let files = [];
    try {
      files = fs.readdirSync(learn.RAW_DIR).filter((f) => f.endsWith('.log')).sort();
    } catch {
      /* none yet */
    }
    const want = pos[0];
    let file = want && fs.existsSync(want) ? want : null;
    if (!file) {
      const hit = want ? files.filter((f) => f.includes(path.basename(want).replace(/\.log$/, ''))) : files;
      if (!hit.length) throw new Error(want ? `no raw log matching "${want}"` : 'no raw logs yet');
      file = path.join(learn.RAW_DIR, hit[hit.length - 1]);
    }
    process.stdout.write(fs.readFileSync(file, 'utf8'));
  },

  learn({ flags }) {
    const learn = require('../src/learn');
    const rows = stats.readRows() || [];
    const { families, bypass } = learn.autoBypassed(rows);
    const fams = Object.entries(families).sort((a, b) => b[1].compressed - a[1].compressed);
    console.log('What TokenArmy has learned from your sessions (local only):\n');
    if (!fams.length) console.log('  Nothing yet. Compressions and raw-log opens are recorded as you work.');
    for (const [f, v] of fams.slice(0, 20)) {
      console.log(`  ${f.padEnd(24)} compressed ${String(v.compressed).padStart(4)}×  raw log opened ${String(v.expanded).padStart(3)}×${bypass.has(f) ? '  → auto-bypassed (agent kept needing the full output)' : ''}`);
    }
    const proposals = learn.mine();
    if (!proposals.length) {
      console.log('\nNo new noise filters to propose (need the same command family in 3+ saved raw logs).');
      return;
    }
    console.log(`\nProposed noise filters (lines that repeat across runs and never carry errors):`);
    for (const p of proposals) {
      console.log(`\n  ${p.name}  (seen in ${p.evidence.logs} logs, ~${p.evidence.lines} lines)`);
      for (const e of p.evidence.examples) console.log(`    drop: ${e}`);
    }
    if (flags.write) console.log(`\nSaved to ${learn.writeRules(proposals)}. Error/failure lines are always kept. Edit or delete the file to undo.`);
    else console.log(`\nRun \`tokenarmy learn --write\` to save these to ${learn.USER_FILTERS}.`);
  },

  async ab({ pos, flags }) {
    if (!pos[0]) throw new Error('usage: tokenarmy ab <config.json> [--out dir]   (see src/ab.js for the config format)');
    const r = await require('../src/ab').ab(pos[0], { out: flags.out });
    console.log(r.md);
    console.log(`\nAll runs, transcripts and results.json: ${r.dir}`);
  },

  help() {
    process.stdout.write(HELP);
  },
  version() {
    console.log(VERSION);
  },
};

const [cmd, ...rest] = process.argv.slice(2);
const fn = commands[cmd] || (cmd === '-v' || cmd === '--version' ? commands.version : commands.help);
const fail = (e) => {
  console.error(`tokenarmy: ${e.message}`);
  process.exitCode = 1;
};
try {
  const r = fn(args(rest));
  if (r && typeof r.catch === 'function') r.catch(fail);
} catch (e) {
  fail(e);
}
