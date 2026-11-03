'use strict';
// Secrets never go to disk. TokenArmy keeps raw outputs (~/.tokenarmy/raw/) and compaction
// checkpoints; a command such as `env`, `cat .env` or a failing curl can print a credential, and
// a copy on disk outlives the session. Matches are replaced with [REDACTED:<kind>] (after
// Hindsight's "Memory Defense"). This applies only to what TokenArmy stores, never to what the
// agent sees. Off: TOKENARMY_REDACT=0.
const PATTERNS = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai_key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe_key', /\b[rs]k_(?:live|test)_[0-9a-zA-Z]{20,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['bearer', /(\bAuthorization:\s*Bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/gi],
  ['url_password', /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)[^\s@\/]{3,}(?=@)/gi],
  // NAME_SECRET=value / "password": "value" (only when the key name says it is a secret)
  ['secret_value', /(\b[A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"',;]{6,}/gi],
];

function redact(text) {
  let s = String(text == null ? '' : text);
  if (process.env.TOKENARMY_REDACT === '0') return s;
  for (const [kind, re] of PATTERNS) {
    s = s.replace(re, (m, keep) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}[REDACTED:${kind}]` : `[REDACTED:${kind}]`));
  }
  return s;
}

module.exports = { redact };
