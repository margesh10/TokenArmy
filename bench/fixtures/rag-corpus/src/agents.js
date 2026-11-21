'use strict';
// Agent adapters. One engine (hooks/claude-posttooluse.js) serves several coding agents:
// each adapter turns that agent's hook payload into the engine's event shape, and turns the
// engine's answer back into what that agent expects on stdout.
//
//   claude   Claude Code      PostToolUse  tool_response            -> hookSpecificOutput.updatedToolOutput
//   copilot  GitHub Copilot   postToolUse  toolResult.textResultForLlm -> modifiedResult (replaces the result)
//            (VS Code agent mode, Copilot CLI; camelCase or PascalCase/snake_case payloads)
//   devin    Devin CLI/Local  PostToolUse  tool_response.output     -> cannot replace output; only
//                                                                        hookSpecificOutput.additionalContext
//
// Formats follow each vendor's published hook reference (Nov 2026).

// Copilot tool names -> the engine's (Claude) tool names.
const COPILOT_TOOLS = { bash: 'Bash', powershell: 'PowerShell', view: 'Read', grep: 'Grep', rg: 'Grep' };
// Devin tool names.
const DEVIN_TOOLS = { exec: 'Bash', read: 'Read', grep: 'Grep' };

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  if (typeof a === 'string') {
    try {
      return JSON.parse(a);
    } catch {
      return {};
    }
  }
  return {};
}

function detect(evt, hint) {
  if (hint === 'claude' || hint === 'copilot' || hint === 'devin') return hint;
  if (!evt || typeof evt !== 'object') return 'claude';
  if (evt.toolResult || evt.toolName || evt.sessionId) return 'copilot'; // camelCase Copilot
  if (evt.tool_result && typeof evt.tool_result === 'object') return 'copilot'; // PascalCase Copilot
  const r = evt.tool_response;
  if (r && typeof r === 'object' && typeof r.output === 'string' && 'success' in r) return 'devin';
  if (DEVIN_TOOLS[evt.tool_name] && evt.prompt_id) return 'devin';
  return 'claude';
}

// Copilot payload -> engine event. Returns null for tools we don't handle.
function fromCopilot(evt) {
  const camel = !!(evt.toolName || evt.toolResult);
  const name = String(camel ? evt.toolName : evt.tool_name || '').toLowerCase();
  const tool = COPILOT_TOOLS[name];
  const result = camel ? evt.toolResult : evt.tool_result;
  const text = result && (camel ? result.textResultForLlm : result.text_result_for_llm);
  if (!tool || typeof text !== 'string') return null;
  const args = parseArgs(camel ? evt.toolArgs : evt.tool_input);
  const base = { agent: 'copilot', camel, session_id: evt.sessionId || evt.session_id, cwd: evt.cwd, tool_name: tool };
  if (tool === 'Bash' || tool === 'PowerShell') {
    return { ...base, tool_input: { command: args.command || '' }, tool_response: { stdout: text, stderr: '' } };
  }
  if (tool === 'Read') {
    const file = args.path || args.file_path || '';
    const range = Array.isArray(args.view_range) ? args.view_range.join('-') : '';
    return { ...base, tool_input: { file_path: file, offset: range }, tool_response: { type: 'text', file: { filePath: file, content: text, numLines: text.split('\n').length } } };
  }
  return { ...base, tool_input: { pattern: args.pattern || '' }, tool_response: { mode: 'content', content: text } };
}

// Devin payload -> engine event (used for observing; Devin can't take replaced output).
function fromDevin(evt) {
  const tool = DEVIN_TOOLS[evt.tool_name];
  const r = evt.tool_response || {};
  if (!tool || typeof r.output !== 'string') return null;
  const args = parseArgs(evt.tool_input);
  return { agent: 'devin', session_id: evt.session_id, cwd: evt.cwd || process.cwd(), tool_name: tool, tool_input: { command: args.command || '', file_path: args.file_path || args.path || '' }, tool_response: { stdout: r.output, stderr: r.error || '' } };
}

// The text the model will see, from the engine's updatedToolOutput.
function textOf(updated) {
  if (!updated) return '';
  if (updated.file && typeof updated.file.content === 'string') return updated.file.content;
  if (typeof updated.content === 'string') return updated.content;
  return [updated.stdout, updated.stderr].filter(Boolean).join('\n');
}

// What to print on stdout, per agent.
function reply(agent, evt, updated, extraContext) {
  if (agent === 'copilot') {
    const out = {};
    if (updated) out.modifiedResult = { resultType: 'success', textResultForLlm: textOf(updated) };
    if (extraContext) out.additionalContext = extraContext;
    return Object.keys(out).length ? out : null;
  }
  if (agent === 'devin') {
    return extraContext ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: extraContext } } : null;
  }
  return updated ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } } : null;
}

// How the model gets a full file back after a "unchanged since last read" note.
function fullReadHint(agent) {
  if (agent === 'copilot') return 'If you no longer have it in context, view it again with a view_range (e.g. [1, 100000]) to get the full file.';
  return 'If you no longer have it in context, Read again with an explicit `limit` (e.g. limit: 100000) to get the full file.';
}

// Session-start context, per agent.
function contextReply(agent, eventName, text) {
  if (!text) return null;
  if (agent === 'copilot') return { additionalContext: text };
  return { hookSpecificOutput: { hookEventName: eventName || 'SessionStart', additionalContext: text } };
}

module.exports = { detect, fromCopilot, fromDevin, reply, textOf, fullReadHint, contextReply, COPILOT_TOOLS, DEVIN_TOOLS };
