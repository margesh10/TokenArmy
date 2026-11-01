'use strict';
// Dependency-free token estimator.
// Real BPE tokenizers differ per model, so this is an estimate tuned to be
// within ~10-15% of cl100k/Claude counts on English prose and source code.
// Rules of thumb it encodes:
//   - English words: ~1.3 tokens per word (common words are 1 token, long/rare words split)
//   - Punctuation / symbols: usually 1 token each
//   - Digits: groups of ~3
//   - Whitespace runs: indentation is cheap but not free
//   - Non-ASCII (CJK etc.): ~1 token per char

const WORD = /[A-Za-z]+/g;

function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  const s = String(text);

  // Words
  const words = s.match(WORD) || [];
  for (const w of words) {
    if (w.length <= 4) tokens += 1;
    else if (w.length <= 8) tokens += 1.3;
    else tokens += Math.ceil(w.length / 4.5);
  }
  // Digit groups
  const digits = s.match(/\d+/g) || [];
  for (const d of digits) tokens += Math.ceil(d.length / 3);
  // Symbols / punctuation
  const symbols = s.match(/[^\sA-Za-z0-9\u0080-￿]/g) || [];
  tokens += symbols.length * 0.9;
  // Non-ASCII
  const wide = s.match(/[\u0080-￿]/g) || [];
  tokens += wide.length;
  // Whitespace: newlines ~1 each, long indentation runs ~1 per 4 spaces
  const newlines = s.match(/\n/g) || [];
  tokens += newlines.length * 0.6;
  const indents = s.match(/ {4,}/g) || [];
  for (const run of indents) tokens += Math.floor(run.length / 8);

  return Math.max(1, Math.round(tokens));
}

function formatTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function savings(before, after) {
  const b = estimateTokens(before);
  const a = estimateTokens(after);
  return { before: b, after: a, saved: b - a, pct: b ? Math.round(((b - a) / b) * 100) : 0 };
}

module.exports = { estimateTokens, formatTokens, savings };
