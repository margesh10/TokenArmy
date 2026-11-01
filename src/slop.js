'use strict';
// AI-slop detector + remover.
// Slop costs tokens twice: once when the model writes it, and again every
// turn it sits in context (CLAUDE.md, docs, chat history, summaries).
// Scoring follows the "markers per 100 words" approach (cf. slop-detector),
// removal is conservative: only phrases that carry zero information.

// Whole sentences/clauses that can be deleted outright.
const FILLER_SENTENCES = [
  /^(great|good|excellent|fantastic|awesome) (question|idea|point|catch)[.!]?\s*/i,
  /^(certainly|sure|absolutely|of course|definitely)[,!.]\s*(here('s| is| are)[^.:\n]*[.:]\s*)?/i,
  /^(i('d| would) be (happy|glad) to help( you)?( with (that|this))?[.!]?)\s*/i,
  /^(i hope (this|that) helps[.!]?)\s*/i,
  /^(let me know if you (have any (other |more )?questions|need (anything else|more help|further assistance))[^.\n]*[.!]?)\s*/i,
  /^(feel free to (ask|reach out)[^.\n]*[.!]?)\s*/i,
  /^(happy coding|hope this helps|cheers)[.!]?\s*$/i,
  /^(in (summary|conclusion|short)|to (sum up|summarize|wrap up)),?\s*/i,
  /^(as an ai( language model)?,?[^.\n]*[.,]\s*)/i,
  /^(here('s| is) (a|the) (breakdown|summary|overview|rundown)( of [^:\n]*)?:?)\s*$/i,
];

// Inline phrases → replacement ('' = delete).
const PHRASES = [
  [/\bit('s| is) (important|worth|crucial) (to note|noting|to mention|mentioning|to remember) (that )?/gi, ''],
  [/\bit should be noted that /gi, ''],
  [/\bplease note that /gi, ''],
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bfor all intents and purposes,? /gi, ''],
  [/\bat the end of the day,? /gi, ''],
  [/\bneedless to say,? /gi, ''],
  [/\bit goes without saying that /gi, ''],
  [/\bin today's (fast-paced|ever-evolving|rapidly changing|digital) (world|landscape|era),? /gi, ''],
  // Only intensifiers that never change meaning. ("just", "really", "very" can, so they stay.)
  [/\b(basically|essentially|literally),? (?=\w)/gi, ''],
  [/\b(delve|delving) into\b/gi, 'explore'],
  [/\bleverag(e|es|ed|ing)\b/gi, (m) => m.replace(/leverag/i, 'us')],
  [/\butiliz(e|es|ed|ing)\b/gi, (m) => m.replace(/utiliz/i, 'us')],
  [/\ba (wide|broad|diverse) (range|array|variety) of\b/gi, 'many'],
  [/\b(seamless(ly)?|robust|cutting-edge|game-chang(er|ing)|state-of-the-art|world-class|best-in-class|next-level|supercharge[ds]?|unlock(s|ing)? the (full )?power of),?\s*/gi, ''],
  [/\bthe (realm|landscape|world|tapestry) of\b/gi, ''],
  [/\bnavigat(e|ing) the (complexities|intricacies) of\b/gi, 'handle'],
];

// Markers that indicate slop (for scoring; not all are auto-removed).
const MARKERS = [
  /\bdelve\b/i, /\btapestry\b/i, /\btestament to\b/i, /\brealm\b/i, /\blandscape\b/i, /\bseamless/i,
  /\brobust\b/i, /\bleverag/i, /\butiliz/i, /\bcrucial\b/i, /\bpivotal\b/i, /\bfoster/i, /\bembark/i,
  /\bunleash/i, /\belevate/i, /\bgame.?chang/i, /\bcutting.?edge\b/i, /\bin today's\b/i,
  /\bit'?s (important|worth|crucial) to (note|mention)/i, /\bnot only\b.*\bbut also\b/i,
  /\bnot just\b.*\bit'?s\b/i, /\bhope this helps\b/i, /\bgreat question\b/i, /\bcertainly!/i,
  /\bin conclusion\b/i, /\bfurthermore\b/i, /\bmoreover\b/i, /\badditionally\b/i, /\bnavigat/i,
  /\bmeticulous/i, /\bintricate\b/i, /\bbustling\b/i, /\bever.?evolving\b/i, /—/,
  /\b(let'?s|let us) dive (in|into)\b/i, /🚀|✨|💡|🔥/u,
];

function words(text) {
  return (String(text).match(/\b[\w']+\b/g) || []).length;
}

function score(text) {
  const prose = stripCode(text);
  const n = words(prose) || 1;
  const hits = [];
  for (const m of MARKERS) {
    const re = new RegExp(m.source, m.flags.includes('g') ? m.flags : m.flags + 'g');
    const found = prose.match(re);
    if (found) hits.push({ marker: m.source, count: found.length });
  }
  const total = hits.reduce((a, h) => a + h.count, 0);
  const per100 = +(total / n * 100).toFixed(2);
  const verdict = per100 < 0.5 ? 'clean' : per100 < 1.5 ? 'mild' : per100 < 3 ? 'sloppy' : 'heavy-slop';
  return { words: n, markers: total, per100words: per100, verdict, hits: hits.sort((a, b) => b.count - a.count) };
}

// Protect fenced/inline code from edits.
function stripCode(text) {
  return String(text).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
}

function withCodeProtected(text, fn) {
  const store = [];
  const masked = String(text).replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    store.push(m);
    return `\u0000${store.length - 1}\u0000`;
  });
  return fn(masked).replace(/\u0000(\d+)\u0000/g, (_, i) => store[+i]);
}

function deslop(text) {
  return withCodeProtected(text, (t) => {
    let lines = t.split('\n').map((line) => {
      let l = line;
      l = l
        .split(/(?<=[.!?])\s+/)
        .map((seg) => FILLER_SENTENCES.reduce((s, re) => s.replace(re, ''), seg))
        .filter((seg) => seg.trim())
        .join(' ');
      for (const [re, rep] of PHRASES) l = l.replace(re, rep);
      // Fix capitalisation after deletions at sentence start.
      l = l.replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
      return l.replace(/ {2,}/g, ' ').replace(/ ([,.;:!?])/g, '$1');
    });
    // Drop lines that became empty because they were pure filler.
    const out = [];
    lines.forEach((l, i) => {
      if (l.trim() === '' && t.split('\n')[i].trim() !== '') return;
      out.push(l);
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  });
}

module.exports = { score, deslop, MARKERS, PHRASES, FILLER_SENTENCES, stripCode };
