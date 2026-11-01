'use strict';
// Minimal line diff (LCS) producing unified-style hunks. Dependency-free.
// Returns null when inputs are too large to diff cheaply; callers then fall back to full content.

const MAX_CELLS = 4e6; // ~2000 x 2000 lines

function diffLines(a, b, ctx = 2) {
  const A = String(a).split('\n');
  const B = String(b).split('\n');
  // Trim common prefix/suffix first: edits are usually local, so this keeps the table tiny.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  if ((a2.length + 1) * (b2.length + 1) > MAX_CELLS) return null;

  const n = a2.length;
  const m = b2.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  // ops over the full files: [' ', line, oldNo, newNo] | ['-', line, oldNo] | ['+', line, null, newNo]
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push([' ', A[k], k + 1, k + 1]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) ops.push([' ', a2[i], pre + ++i, pre + ++j]);
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push(['-', a2[i], pre + ++i, null]);
    else ops.push(['+', b2[j], null, pre + ++j]);
  }
  for (let k = 0; k < suf; k++) ops.push([' ', A[A.length - suf + k], A.length - suf + k + 1, B.length - suf + k + 1]);

  const changed = ops.map((o, idx) => (o[0] !== ' ' ? idx : -1)).filter((x) => x >= 0);
  if (!changed.length) return { changes: 0, text: '' };
  const hunks = [];
  let start = Math.max(0, changed[0] - ctx);
  let end = Math.min(ops.length - 1, changed[0] + ctx);
  for (const c of changed.slice(1)) {
    if (c - ctx <= end + 1) end = Math.min(ops.length - 1, c + ctx);
    else {
      hunks.push([start, end]);
      start = Math.max(0, c - ctx);
      end = Math.min(ops.length - 1, c + ctx);
    }
  }
  hunks.push([start, end]);
  const out = [];
  for (const [s, e] of hunks) {
    const first = ops.slice(s, e + 1).find((o) => o[3] != null) || ops[s];
    out.push(`@@ new line ${first[3] || first[2]} @@`);
    for (let k = s; k <= e; k++) out.push(ops[k][0] + ' ' + ops[k][1]);
  }
  return { changes: changed.length, text: out.join('\n') };
}

module.exports = { diffLines };
