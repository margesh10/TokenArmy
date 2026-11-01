#!/usr/bin/env node
'use strict';
// Claude Code PreCompact + SessionStart hook.
//   PreCompact            save a checkpoint (user asks, files changed, commands, todos) from the transcript
//   SessionStart:compact  hand the checkpoint back as context, so facts survive the summary
//   SessionStart:*        forget which files were read (the re-read dedupe must not assume old context)
// Opt out: TOKENARMY_OFF=1 or TOKENARMY_CHECKPOINT=0.
const fs = require('fs');
const path = require('path');
const session = require('../src/session');
const checkpoint = require('../src/checkpoint');
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
  if (process.env.TOKENARMY_CHECKPOINT === '0') return;

  if (evt.hook_event_name === 'PreCompact' && evt.transcript_path) {
    const cp = checkpoint.build(evt.transcript_path);
    if (cp) {
      fs.mkdirSync(session.dir(sid), { recursive: true });
      fs.writeFileSync(path.join(session.dir(sid), 'checkpoint.md'), cp);
    }
    return;
  }
  if (evt.hook_event_name === 'SessionStart' && evt.source === 'compact') {
    const file = path.join(session.dir(sid), 'checkpoint.md');
    let cp;
    try {
      cp = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    stats.record({ kind: 'checkpoint', session: sid, cmd: 'restore after compaction', before: 0, after: 0, restored: estimateTokens(cp) });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: cp } }));
  }
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
