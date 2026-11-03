#!/usr/bin/env node
'use strict';
// Claude Code PreCompact + SessionStart hook.
//   PreCompact            save a checkpoint (user asks, files changed, commands, todos) from the transcript
//   SessionStart:compact  hand the checkpoint back as context, so facts survive the summary
//   SessionStart:*        forget which files were read (the re-read dedupe must not assume old context)
//                         and state the environment facts learned in this repository (src/facts.js)
// Opt out: TOKENARMY_OFF=1, TOKENARMY_CHECKPOINT=0 or TOKENARMY_FACTS=0.
const fs = require('fs');
const path = require('path');
const session = require('../src/session');
const checkpoint = require('../src/checkpoint');
const facts = require('../src/facts');
const { redact } = require('../src/redact');
const brief = require('../src/brief');
const stats = require('../src/stats');
const { estimateTokens } = require('../src/tokens');

function main(raw) {
  if (process.env.TOKENARMY_OFF === '1') return;
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  const sid = evt.session_id;
  if (!sid) return;
  // Whatever happens next, earlier reads may no longer be in context.
  session.remove(sid, 'reads.json');
  const checkpoints = process.env.TOKENARMY_CHECKPOINT !== '0';

  if (evt.hook_event_name === 'PreCompact' && evt.transcript_path && checkpoints) {
    const cp = checkpoint.build(evt.transcript_path);
    if (cp) {
      fs.mkdirSync(session.dir(sid), { recursive: true });
      fs.writeFileSync(path.join(session.dir(sid), 'checkpoint.md'), redact(cp));
    }
    return;
  }
  if (evt.hook_event_name !== 'SessionStart') return;
  const parts = [];
  // Environment facts learned in earlier sessions here (see src/facts.js). Re-sent after
  // compaction too: the summary may not keep them.
  // Together with the project brief (src/brief.js) under one header.
  const factLines = facts.lines(evt.cwd);
  const block = brief.render(evt.cwd, factLines);
  if (block) {
    parts.push(block);
    stats.record({ kind: 'facts', session: sid, cmd: `session start (${evt.source || 'startup'})`, before: 0, after: 0, facts: factLines.length, lines: block.split('\n').length - 1, restored: estimateTokens(block) });
  }
  if (evt.source === 'compact' && checkpoints) {
    try {
      const cp = fs.readFileSync(path.join(session.dir(sid), 'checkpoint.md'), 'utf8');
      parts.push(cp);
      stats.record({ kind: 'checkpoint', session: sid, cmd: 'restore after compaction', before: 0, after: 0, restored: estimateTokens(cp) });
    } catch {
      /* no checkpoint saved */
    }
  }
  if (parts.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } }));
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  try {
    main(buf);
  } catch {
    /* a hook must never break the agent */
  }
});
