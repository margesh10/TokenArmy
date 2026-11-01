'use strict';
// Prompt / context-file compression (CLAUDE.md, AGENTS.md, system prompts, RAG chunks).
// Levels:
//   1 safe     – whitespace, duplicate lines, minify JSON blocks, strip HTML comments
//   2 standard – + deslop prose, collapse markdown decoration, shorten boilerplate
//   3 aggressive – + drop articles/stopwords in prose bullets (telegraphic style,
//                  the "caveman" idea applied to INPUT, which is billed every turn)
// Code blocks, URLs, paths, numbers and quoted strings are never altered.

const { deslop, tidy } = require('./slop');

const STOP = new Set('a an the that which very really quite just so then also of'.split(' '));

function protect(text, fn) {
  const store = [];
  const masked = String(text).replace(/```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+|"[^"\n]{0,200}"/g, (m) => {
    store.push(m);
    return `\u0001${store.length - 1}\u0001`;
  });
  return fn(masked).replace(/\u0001(\d+)\u0001/g, (_, i) => store[+i]);
}

function minifyJsonBlocks(text) {
  return text.replace(/```json\n([\s\S]*?)```/g, (m, body) => {
    try {
      return '```json\n' + JSON.stringify(JSON.parse(body)) + '\n```';
    } catch {
      return m;
    }
  });
}

function dedupeLines(text) {
  const seen = new Set();
  let inFence = false;
  return text
    .split('\n')
    .filter((l) => {
      if (/^\s*```/.test(l)) {
        inFence = !inFence;
        return true;
      }
      if (inFence) return true; // never touch code
      const k = l.trim().toLowerCase();
      if (k.length < 12) return true; // short lines (headings, braces) are fine to repeat
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join('\n');
}

function safe(text) {
  let t = String(text).replace(/\r\n/g, '\n');
  t = minifyJsonBlocks(t);
  t = protect(t, (m) => m.replace(/<!--[\s\S]*?-->/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n'));
  t = dedupeLines(t);
  return t.trim() + '\n';
}

function standard(text) {
  let t = safe(text);
  t = deslop(t);
  t = protect(t, (m) =>
    m
      .split('\n')
      .map((line) => {
        const l = line
          .replace(/^(#{1,6})\s*(.*?)\s*#*\s*$/, '$1 $2')
          .replace(/\*\*(.+?)\*\*/g, '$1') // bold adds tokens, rarely meaning
          .replace(/^\s*[-*_]{3,}\s*$/, '') // horizontal rules
          .replace(/^(\s*)[*+] /, '$1- ')
          .replace(/\bYou (must|should) always\b/g, 'Always')
          .replace(/\bYou (must|should) never\b/g, 'Never')
          .replace(/\b(please,?\s+)?(make sure|ensure) (to|that you)\s+/gi, '')
          .replace(/\bplease,?\s+(?=[a-z])/gi, '');
        return l === line ? l : tidy(l);
      })
      .join('\n')
  );
  return t.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function aggressive(text) {
  const t = standard(text);
  return protect(t, (m) =>
    m
      .split('\n')
      .map((line) => {
        if (/^\s*(#|\||\u0001)/.test(line) || line.trim() === '') return line;
        const indent = line.match(/^\s*(?:[-\d.]+\s)?/)[0];
        const body = line.slice(indent.length);
        const kept = body.split(/(\s+)/).filter((w, i, arr) => {
          if (/^\s+$/.test(w)) return true;
          return !STOP.has(w.toLowerCase());
        });
        return indent + kept.join('').replace(/\s{2,}/g, ' ').trim();
      })
      .join('\n')
  );
}

function compress(text, level = 2) {
  if (level <= 1) return safe(text);
  if (level === 2) return standard(text);
  return aggressive(text);
}

module.exports = { compress, safe, standard, aggressive, minifyJsonBlocks, dedupeLines };
