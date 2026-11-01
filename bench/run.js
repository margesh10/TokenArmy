#!/usr/bin/env node
'use strict';
// Reproducible benchmark: `npm run bench`
// Writes bench/fixtures/*.txt, bench/out/*.txt (compressed), bench/results.json,
// and regenerates the README charts in assets/.

const fs = require('fs');
const path = require('path');
const { estimateTokens } = require('../src/tokens');
const { squeeze } = require('../src/squeeze');
const prompt = require('../src/prompt');
const ctx = require('../src/context');
const { writeAll } = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const fx = writeAll(path.join(__dirname, 'fixtures'));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const rows = [];
function measure(id, label, tool, before, after) {
  fs.writeFileSync(path.join(OUT, `${id}.txt`), after);
  const b = estimateTokens(before);
  const a = estimateTokens(after);
  rows.push({ id, label, tool, before: b, after: a, saved: b - a, pct: Math.round(((b - a) / b) * 100), linesBefore: before.split('\n').length, linesAfter: after.split('\n').length });
}

const cmdCases = [
  ['jest', 'jest: 241 tests, 1 failing', 'jest'],
  ['pytest', 'pytest -v: 301 tests, 1 failing', 'pytest'],
  ['npmInstall', 'npm install (verbose)', 'npmInstall'],
  ['docker', 'docker build', 'docker'],
  ['tsc', 'tsc: 90 type errors', 'tsc'],
  ['gitLog', 'git log: 60 commits', 'gitLog'],
  ['gitStatus', 'git status: 32 files', 'gitStatus'],
];
for (const [id, label, key] of cmdCases) measure(id, label, 'hook / run', fx[key].text, squeeze(fx[key].text, { command: fx[key].cmd }));

measure('claudeMd', 'Sloppy CLAUDE.md', 'compress --level 2', fx.claudeMd.text, prompt.compress(fx.claudeMd.text, 2));

const realFile = fs.readFileSync(path.join(ROOT, 'src', 'context.js'), 'utf8');
measure('outline', 'Read 230-line source file', 'outline', realFile, ctx.outline(realFile, 'context.js'));

// RAG: src/ + docs/ as corpus (stable: excludes README so editing it doesn't move the numbers)
// vs a 1,500-token pack for one question.
const files = [...ctx.walk(path.join(ROOT, 'src'), /\.js$/), ...ctx.walk(path.join(ROOT, 'docs'), /\.md$/), path.join(ROOT, 'hooks', 'claude-posttooluse.js')];
let corpus = '';
const chunks = [];
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  corpus += t + '\n';
  chunks.push(...ctx.chunk(t, { source: path.relative(ROOT, f).replace(/\\/g, '/') }));
}
const packed = ctx.pack(chunks, 'how does the hook keep the raw output recoverable', 1500);
measure('rag', 'RAG: src+docs vs 1.5k pack', 'pack', corpus, packed.text);

// ---- 40-turn session model -------------------------------------------------
// Each turn the agent resends: fixed preload + all history so far.
// Fixed preload = system + tool schemas (15k, unchanged by TokenArmy) + CLAUDE.md.
// Every 2nd turn runs one of the commands above (cycled); other turns add 400 tokens of chat.
const TURNS = 40;
const SYSTEM = 15000;
const cycle = cmdCases.map(([id]) => rows.find((r) => r.id === id));
const md = rows.find((r) => r.id === 'claudeMd');
function session(compressed) {
  const pre = SYSTEM + (compressed ? md.after : md.before);
  let history = 0;
  let cumulative = 0;
  const series = [];
  for (let t = 1; t <= TURNS; t++) {
    cumulative += pre + history;
    series.push(cumulative);
    const r = cycle[(t - 1) % cycle.length];
    history += t % 2 === 0 ? (compressed ? r.after : r.before) : 400;
  }
  return series;
}
const without = session(false);
const withTA = session(true);
const sessionResult = { turns: TURNS, systemTokens: SYSTEM, without: without[TURNS - 1], with: withTA[TURNS - 1], pct: Math.round(((without[TURNS - 1] - withTA[TURNS - 1]) / without[TURNS - 1]) * 100), seriesWithout: without, seriesWith: withTA };

const results = { generated: new Date().toISOString().slice(0, 10), estimator: 'tokenarmy heuristic (±15% vs BPE)', rows, session: sessionResult };
fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2) + '\n');

console.log('scenario'.padEnd(34), 'before'.padStart(7), 'after'.padStart(7), 'saved'.padStart(6));
for (const r of rows) console.log(r.label.padEnd(34), String(r.before).padStart(7), String(r.after).padStart(7), (r.pct + '%').padStart(6));
console.log(`\n40-turn session (uncached input): ${without[TURNS - 1].toLocaleString()} → ${withTA[TURNS - 1].toLocaleString()} tokens (−${sessionResult.pct}%)`);

require('./charts').render(results, path.join(ROOT, 'assets'));
console.log('charts → assets/');
