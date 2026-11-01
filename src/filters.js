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
      const key = `${m[4]} ${m[5] || ''} ${m[6]}`.trim();
      const entry = counts.get(key) || { n: 0, first: l.trim(), files: new Set() };
      entry.n++;
      entry.files.add(m[1].trim());
      counts.set(key, entry);
    } else if (SIGNAL.test(l) || /^\s*(Found|✖|\d+ problems?)/.test(l)) outLines.push(l);
  }
  if (matched < 5) return null;
  const grouped = [...counts.values()].map((e) =>
    e.n === 1 ? e.first : `${e.first}  (×${e.n} across ${e.files.size} file${e.files.size === 1 ? '' : 's'})`
  );
  return [...grouped, ...outLines].join('\n');
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
  { name: 'diagnostics', cmd: /\b(tsc|eslint|cargo\s+(build|check|clippy)|gcc|g\+\+|clang|mypy|ruff|pylint|go\s+vet|dotnet\s+build)\b/, fn: compilerDiagnostics },
  { name: 'docker', cmd: /\bdocker\s+(build|compose\s+build|buildx)\b/, fn: dockerBuild },
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

module.exports = { applyFilter, detectFilter, RULES, gitStatus, gitLog, packageInstall, testRunner, listing, compilerDiagnostics, dockerBuild };
