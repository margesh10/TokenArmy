'use strict';
// Claude Code status line: model · context used · session $ · TokenArmy savings.
// Claude Code pipes a JSON blob on stdin each refresh; we print one line.
const stats = require('./stats');
const { formatTokens } = require('./tokens');

// Input $ per 1M tokens (Anthropic first-party list prices, Oct 2026).
// Order matters: first match wins. Override with TOKENARMY_PRICE_PER_MTOK.
const INPUT_PRICE = [
  [/fable|mythos/, 10],
  [/opus-5-5/, 4],
  [/opus/, 5],
  [/sonnet-5/, 2],
  [/sonnet/, 3],
  [/haiku-5/, 0.1],
  [/haiku/, 1],
];

function inputPrice(modelId) {
  const env = parseFloat(process.env.TOKENARMY_PRICE_PER_MTOK);
  if (env >= 0) return env;
  const id = String(modelId || '').toLowerCase();
  for (const [re, p] of INPUT_PRICE) if (re.test(id)) return p;
  return 4; // unknown model: assume the default Opus rate
}

function money(n) {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(3)}`;
  return '$0';
}

function render(input, opts = {}) {
  const env = opts.env || process.env;
  const color = !env.NO_COLOR;
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const green = (s) => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const yellow = (s) => (color ? `\x1b[33m${s}\x1b[0m` : s);

  const model = input.model || {};
  const parts = [model.display_name || model.id || 'Claude'];

  // Context window usage (field names vary across Claude Code versions; all optional).
  const cw = input.context_window || {};
  const used = cw.current_usage
    ? (cw.current_usage.input_tokens || 0) + (cw.current_usage.cache_read_input_tokens || 0) + (cw.current_usage.cache_creation_input_tokens || 0)
    : null;
  const pct = typeof cw.used_percentage === 'number' ? Math.round(cw.used_percentage) : used != null && cw.context_window_size ? Math.round((used / cw.context_window_size) * 100) : null;
  if (used != null) {
    const size = cw.context_window_size ? `/${formatTokens(cw.context_window_size)}` : '';
    parts.push(`ctx ${formatTokens(used)}${size}${pct != null ? ` (${pct}%)` : ''}`);
  } else if (pct != null) {
    parts.push(`ctx ${pct}%`);
  }
  if (cw.total_input_tokens != null || cw.total_output_tokens != null) {
    parts.push(`${formatTokens(cw.total_input_tokens || 0)} in / ${formatTokens(cw.total_output_tokens || 0)} out`);
  }

  // Session cost as reported by Claude Code (an estimate; subscription users aren't billed per token).
  const cost = input.cost && typeof input.cost.total_cost_usd === 'number' ? input.cost.total_cost_usd : null;
  if (cost != null) parts.push(yellow(money(cost)));

  // TokenArmy savings for this session (falls back to all-time if no session id).
  const s = stats.summary(input.session_id ? { session: input.session_id } : {});
  if (s.saved > 0) {
    const usd = (s.saved / 1e6) * inputPrice(model.id);
    parts.push(green(`TokenArmy saved ${formatTokens(s.saved)} tok (−${s.pct}%, ≥${money(usd)})`));
  } else {
    parts.push(dim('TokenArmy saved 0'));
  }
  return parts.join(dim(' · '));
}

module.exports = { render, inputPrice };
