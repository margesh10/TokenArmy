'use strict';
// Compaction checkpoint: before Claude Code compacts, pull the hard facts out of the transcript
// (what the user asked, which files changed, recent commands, open todos) so they can be handed
// back verbatim after compaction instead of relying on a lossy summary.
const fs = require('fs');

function build(transcriptPath, { prompts = 5, commands = 8 } = {}) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const asks = [];
  const files = new Map(); // path -> 'created' | 'edited'
  const cmds = [];
  let todos = null;
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = e.message || {};
    if (e.type === 'user' && typeof msg.content === 'string' && !e.isMeta && !/^<(command|local-command|system)/.test(msg.content.trim())) {
      asks.push(msg.content.trim().replace(/\s+/g, ' ').slice(0, 300));
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'text' && e.type === 'user' && !e.isMeta && b.text && !/^<|^\[Request interrupted/.test(b.text.trim())) asks.push(b.text.trim().replace(/\s+/g, ' ').slice(0, 300));
        if (b.type !== 'tool_use' || !b.input) continue;
        if ((b.name === 'Bash' || b.name === 'PowerShell') && b.input.command) cmds.push(b.input.command.replace(/\s+/g, ' ').slice(0, 160));
        if (b.name === 'TodoWrite' && Array.isArray(b.input.todos)) todos = b.input.todos;
      }
    }
    const r = e.toolUseResult;
    if (r && typeof r === 'object' && r.filePath && (r.type === 'create' || r.structuredPatch)) {
      files.set(r.filePath, r.type === 'create' && !files.has(r.filePath) ? 'created' : files.get(r.filePath) || 'edited');
    }
  }
  if (!asks.length && !files.size && !cmds.length) return null;
  const out = ['## TokenArmy checkpoint (saved just before compaction)'];
  if (asks.length) {
    out.push('', 'What the user asked (most recent last):');
    for (const a of asks.slice(-prompts)) out.push(`- ${a}`);
  }
  if (files.size) {
    out.push('', 'Files changed this session:');
    for (const [f, how] of [...files].slice(-40)) out.push(`- ${f} (${how})`);
  }
  if (cmds.length) {
    out.push('', 'Recent commands:');
    for (const c of cmds.slice(-commands)) out.push(`- \`${c}\``);
  }
  if (todos && todos.length) {
    out.push('', 'Todo list:');
    for (const t of todos) out.push(`- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`);
  }
  out.push('', 'Re-read any file above before editing it; earlier reads were compacted away.');
  return out.join('\n');
}

module.exports = { build };
