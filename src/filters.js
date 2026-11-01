'use strict';
// Command-aware filters. Each filter returns a compressed string or null
// (null = "not mine / nothing to gain", fall through to generic squeeze).
// Filters must NEVER drop failure information.

const { SIGNAL } = require('./squeeze-signal');

function gitStatus(out) {
  // Turn verbose `git status` into porcelain-like summary.
  const lines = out.split('\n');
  const branch = (out.match(/On branch (\S+)/) || [])[1];
  const ahead = (out.match(/ahead of '[^']+' by (\d+)/) || [])[1];
  const behind = (out.match(/behind '[^']+' by (\d+)/) || [])[1];
  const groups = { staged: [], modified: [], untracked: [], conflicts: [] };
  let section = null;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^Changes to be committed/.test(l)) section = 'staged';
    else if (/^Changes not staged/.test(l)) section = 'modified';
    else if (/^Untracked files/.test(l)) section = 'untracked';
    else if (/^Unmerged paths/.test(l)) section = 'conflicts';
    else if (/^\s+\(use "git/.test(l) || l.trim() === '') continue;
    else if (section && /^\s+/.test(raw)) {
      const m = l.trim().match(/^(new file|modified|deleted|renamed|both modified|both added|typechange):\s+(.*)$/);
      groups[section].push(m ? `${m[1][0].toUpperCase()} ${m[2]}` : l.trim());
    }
  }
  if (!branch) return null;
  const head = `branch ${branch}${ahead ? ` +${ahead}` : ''}${behind ? ` -${behind}` : ''}`;
  const parts = [head];
  for (const [k, v] of Object.entries(groups)) {
    if (!v.length) continue;
    const shown = v.slice(0, 40);
    parts.push(`${k} (${v.length}): ${shown.join(', ')}${v.length > 40 ? `, … +${v.length - 40}` : ''}`);
  }
  if (parts.length === 1) parts.push('clean');
  return parts.join('\n');
}

function gitLog(out) {
  // Full `git log` → one line per commit.
  if (!/^commit [0-9a-f]{7,}/m.test(out)) return null;
  const commits = out.split(/^commit /m).filter(Boolean);
  return commits
    .map((c) => {
      const sha = c.slice(0, 7);
      const author = ((c.match(/^Author:\s+([^<\n]+)/m) || [])[1] || '').trim();
      const date = ((c.match(/^Date:\s+(.+)$/m) || [])[1] || '').trim().split(/\s+/).filter((_, i) => i === 1 || i === 2 || i === 4).join(' ');
      const msg = (c.split('\n').slice(1).find((l) => /^\s{4}\S/.test(l)) || '').trim();
      return `${sha} ${date} ${author}: ${msg}`;
    })
    .join('\n');
}

function packageInstall(out) {
  // npm/pnpm/yarn/pip install: keep summary, warnings, errors.
  const lines = out.split('\n');
  const keep = lines.filter(
    (l) =>
      SIGNAL.test(l) ||
      /^(added|removed|changed|up to date|audited|found \d+|\d+ packages?|Successfully installed|Requirement already satisfied: \S+$|Done in|Packages: |Progress: resolved .* done)/i.test(l.trim()) ||
      /vulnerabilit/i.test(l)
  );
  const dedup = [...new Set(keep.map((l) => l.trim()))];
  if (!dedup.length) return `install finished (${lines.length} lines of output, no warnings/errors)`;
  return dedup.join('\n');
}

function testRunner(out) {
  // jest / vitest / mocha / pytest / cargo / go test / node --test:
  // drop passing tests, keep failures (with their bodies) and the summary.
  const lines = out.split('\n');
  const PASS = /^\s*(✓|✔|√|PASS\b|ok\s+\d|ok\s+\S+\s+[\d.]+s|test .* \.\.\. ok$|.*PASSED(\s|$)|--- PASS|=== RUN|\.+\s*\[\s*\d+%\]$|# pass|# Subtest)/;
  const SUMMARY = /^\s*(Tests?:|Test Suites?:|Snapshots:|Time:|Ran all|=+ .*(passed|failed|error).* =+$|test result:|\d+ (passing|failing|pending)|FAIL\b|ok\s+\S+\s+[\d.]+s$|FAIL\s|# (tests|pass|fail|suites|duration_ms))/i;
  const out2 = [];
  let inFailure = 0;
  let passed = 0;
  for (const l of lines) {
    if (PASS.test(l) && !/^\s*(not ok|FAIL)/.test(l)) {
      passed++;
      inFailure = 0;
      continue;
    }
    if (SIGNAL.test(l) || /^\s*(●|✕|✖|FAIL|FAILED|---\s*FAIL|not ok)/.test(l)) {
      inFailure = 25;
      out2.push(l);
      continue;
    }
    if (SUMMARY.test(l)) {
      out2.push(l);
      continue;
    }
    if (inFailure > 0) {
      out2.push(l);
      inFailure--;
    }
  }
  if (passed) out2.unshift(`[tokenarmy] ${passed} passing test line${passed === 1 ? '' : 's'} hidden`);
  return out2.join('\n');
}

function listing(out) {
  // ls -la / dir / find with huge output: group by directory, drop noise dirs.
  const lines = out.split('\n').filter(Boolean);
  if (lines.length < 60) return null;
  const NOISE = /(^|[\\/])(node_modules|\.git|__pycache__|\.venv|venv|dist|build|target|\.next|\.cache|coverage)([\\/]|$)/;
  const kept = lines.filter((l) => !NOISE.test(l));
  const dropped = lines.length - kept.length;
  const res = kept.slice(0, 150);
  if (kept.length > 150) res.push(`… +${kept.length - 150} more entries`);
  if (dropped) res.push(`[tokenarmy] ${dropped} entries under node_modules/.git/build dirs hidden`);
  return res.join('\n');
}

function compilerDiagnostics(out) {
  // tsc / eslint / cargo build / gcc: group repeated identical diagnostics.
  const lines = out.split('\n');
  const diag = /^(.+?)[(:](\d+)[,:](\d+)\)?:?\s*(error|warning)\s*(\w+)?:?\s*(.*)$/i;
  const counts = new Map();
  const outLines = [];
  let matched = 0;
  for (const l of lines) {
    const m = l.match(diag);
    if (m) {
      matched++;
      const key = `${m[4]} ${m[5] || ''}: ${m[6]}`.trim();
      const entry = counts.get(key) || { n: 0, key, locs: [] };
      entry.n++;
      entry.locs.push(`${m[1].trim()}:${m[2]}`);
      counts.set(key, entry);
    } else if (SIGNAL.test(l) || /^\s*(Found|✖|\d+ problems?)/.test(l)) outLines.push(l);
  }
  if (matched < 5) return lintCodes(out) || buildProgress(out);
  // Message once per kind, then every location (the agent needs them to fix anything).
  const grouped = [...counts.values()].map((e) => {
    const shown = e.locs.slice(0, 60);
    return `${e.key} (×${e.n})\n  ${shown.join(', ')}${e.locs.length > 60 ? `, … +${e.locs.length - 60}` : ''}`;
  });
  return [...grouped, ...outLines].join('\n');
}

// ruff / flake8 / pylint style: path:line:col: CODE message -> one line per rule code, every location kept.
function lintCodes(out) {
  const re = /^(.+?):(\d+):(\d+):\s*([A-Z]{1,4}\d{2,4})\s+(.*)$/;
  const by = new Map();
  const rest = [];
  let matched = 0;
  for (const l of out.split('\n')) {
    const m = l.match(re);
    if (!m) {
      if (l.trim() && (SIGNAL.test(l) || /^(Found|\d+ (errors?|problems?)|\[\*\])/i.test(l.trim()))) rest.push(l);
      continue;
    }
    matched++;
    const e = by.get(m[4]) || { msgs: new Set(), locs: [] };
    e.msgs.add(m[5].trim());
    e.locs.push(`${m[1]}:${m[2]}`);
    by.set(m[4], e);
  }
  if (matched < 5) return null;
  const lines = [...by.entries()]
    .sort((a, b) => b[1].locs.length - a[1].locs.length)
    .map(([code, e]) => {
      const msg = [...e.msgs];
      return `${code} ${msg[0]}${msg.length > 1 ? ` (+${msg.length - 1} variants)` : ''} (×${e.locs.length})\n  ${e.locs.slice(0, 60).join(', ')}${e.locs.length > 60 ? `, … +${e.locs.length - 60}` : ''}`;
    });
  return [...lines, ...rest].join('\n');
}

// cargo / mvn / gradle / dotnet / pip progress lines -> one count per verb; everything else kept.
const PROGRESS = /^\s*(Compiling|Checking|Fresh|Downloaded|Downloading|Updating|Locking|Adding|Installing|Unpacking|Collecting|Using cached|Building wheel|Created wheel|Stored in directory|> Task\b|\[INFO\] (Download(ing|ed)|Building|Installing|---|Copying|Using|Compiling)|Download(ing|ed) from|Progress \(\d+\))/;
function buildProgress(out) {
  const counts = new Map();
  const kept = [];
  for (const l of out.split('\n')) {
    const m = !SIGNAL.test(l) && l.match(PROGRESS);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    else kept.push(l);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total < 10) return null;
  const summary = [...counts.entries()].map(([k, n]) => `${k.replace(/^\[INFO\] /, '')} ×${n}`).join(', ');
  return [`[tokenarmy] ${total} progress lines collapsed: ${summary}`, ...kept].join('\n');
}

// git diff: drop index/---/+++ noise, keep 1 line of context around each change.
function gitDiff(out) {
  if (!/^diff --git /m.test(out)) return null;
  const lines = out.split('\n');
  const res = [];
  let ctx = [];
  let afterChange = 0;
  const flush = () => {
    if (ctx.length > 1) res.push(`  … ${ctx.length - 1} unchanged line${ctx.length - 1 === 1 ? '' : 's'}`);
    if (ctx.length) res.push(ctx[ctx.length - 1]);
    ctx = [];
  };
  for (const l of lines) {
    const m = l.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      ctx = [];
      afterChange = 0;
      res.push(`=== ${m[2]}${m[1] !== m[2] ? ` (renamed from ${m[1]})` : ''}`);
      continue;
    }
    if (/^(index [0-9a-f]+\.\.|--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null))/.test(l)) continue;
    if (/^@@/.test(l)) {
      ctx = [];
      afterChange = 0;
      res.push(l.replace(/^(@@ [^@]+ @@).*/, '$1'));
      continue;
    }
    if (/^[+-]/.test(l)) {
      flush();
      res.push(l);
      afterChange = 1;
      continue;
    }
    if (afterChange > 0) {
      res.push(l);
      afterChange--;
      continue;
    }
    ctx.push(l);
  }
  if (ctx.length > 1) res.push(`  … ${ctx.length} unchanged lines`);
  return res.join('\n');
}

// git push / pull / fetch / clone: drop transfer progress, keep refs, conflicts and errors.
function gitTransfer(out) {
  const NOISE = /^(remote:\s*)?(Enumerating objects|Counting objects|Compressing objects|Writing objects|Total \d+|Delta compression|Resolving deltas|Receiving objects|Unpacking objects|Updating files|Checking out files|Filtering content)\b/;
  const lines = out.split('\n');
  const kept = lines.filter((l) => l.trim() && !NOISE.test(l.trim()));
  if (kept.length === lines.filter((l) => l.trim()).length) return null;
  return kept.join('\n') || 'done (transfer progress hidden)';
}

// docker ps / kubectl get / podman: long tables -> header, unhealthy rows, first rows, count.
function bigTable(out) {
  const lines = out.split('\n').filter((l) => l.trim());
  if (lines.length < 40) return null;
  const BAD = /CrashLoopBackOff|Error|Failed|Evicted|OOMKilled|Pending|Unknown|Exited \([1-9]\d*\)|unhealthy|Restarting/i;
  const [header, ...rows] = lines;
  const bad = rows.filter((r) => BAD.test(r));
  const first = rows.filter((r) => !BAD.test(r)).slice(0, 25);
  const hidden = rows.length - bad.length - first.length;
  return [header, ...bad, ...first, ...(hidden > 0 ? [`… +${hidden} more rows (${rows.length} total, ${bad.length} unhealthy shown first)`] : [])].join('\n');
}

function dockerBuild(out) {
  if (!/^#\d+ |Step \d+\/\d+/m.test(out)) return null;
  return out
    .split('\n')
    .filter((l) => SIGNAL.test(l) || /^(#\d+ \[|Step \d+\/\d+|Successfully|#\d+ DONE|#\d+ naming|writing image)/.test(l.trim()))
    .join('\n');
}

const RULES = [
  { name: 'git-status', cmd: /\bgit\s+status\b(?!.*(--porcelain|-s\b|--short))/, fn: gitStatus },
  { name: 'git-log', cmd: /\bgit\s+log\b(?!.*(--oneline|--format|--pretty))/, fn: gitLog },
  { name: 'install', cmd: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\buv\s+(pip|sync|add)\b|\bpoetry\s+(install|add)\b/, fn: packageInstall },
  { name: 'tests', cmd: /\b(jest|vitest|mocha|pytest|py\.test|cargo\s+test|go\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|node\s+--test|dotnet\s+test|rspec|phpunit)\b/, fn: testRunner },
  { name: 'diagnostics', cmd: /\b(tsc|eslint|cargo\s+(build|check|clippy)|gcc|g\+\+|clang|mypy|ruff|flake8|pylint|go\s+vet|dotnet\s+build)\b/, fn: compilerDiagnostics },
  { name: 'build', cmd: /\b(mvn|mvnw|gradle|gradlew|cargo\s+(run|install|fetch|update)|dotnet\s+(restore|publish)|cmake\s+--build|make)\b/, fn: (o) => compilerDiagnostics(o) || buildProgress(o) },
  { name: 'docker', cmd: /\bdocker\s+(build|compose\s+build|buildx)\b/, fn: dockerBuild },
  { name: 'git-diff', cmd: /\bgit\s+(diff|show)\b(?!.*(--stat|--name-only|--name-status|--numstat|--shortstat))/, fn: gitDiff },
  { name: 'git-transfer', cmd: /\bgit\s+(push|pull|fetch|clone)\b/, fn: gitTransfer },
  { name: 'table', cmd: /\b(docker|podman)\s+(ps|images|container\s+ls|image\s+ls)\b|\bkubectl\s+get\b|\boc\s+get\b/, fn: bigTable },
  { name: 'listing', cmd: /^\s*(ls|dir|find|tree|Get-ChildItem|gci)\b/, fn: listing },
];

function detectFilter(command) {
  if (!command) return null;
  return RULES.find((r) => r.cmd.test(command)) || null;
}

function applyFilter(command, output) {
  const rule = detectFilter(command);
  if (!rule) return null;
  try {
    const res = rule.fn(output);
    if (res == null) return null;
    // Safety net: never return something that lost a failure line entirely.
    // (Passing-test lines are exempt: a test *named* "handles error" is not a failure.)
    const isPassLine = (l) => rule.name === 'tests' && /^\s*(✓|✔|√|ok\s|PASS\b|.*PASSED(\s|$)|--- PASS)/.test(l);
    const hadSignal = output.split('\n').some((l) => SIGNAL.test(l) && !isPassLine(l));
    const keptSignal = res.split('\n').some((l) => SIGNAL.test(l));
    if (hadSignal && !keptSignal) return null;
    return res;
  } catch {
    return null;
  }
}

module.exports = { applyFilter, detectFilter, RULES, gitStatus, gitLog, packageInstall, testRunner, listing, compilerDiagnostics, dockerBuild, lintCodes, buildProgress, gitDiff, gitTransfer, bigTable };
