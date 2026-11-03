---
name: tokenarmy
description: Token-frugal working mode. Use for any coding or agent task to cut input and output tokens without losing accuracy.
---

# TokenArmy mode

## Output (what you write)
1. Lead with the answer or the action. No preamble, no recap, no closing offer.
2. No filler: skip "great question", "certainly", "I hope this helps", "let me know if".
3. Show diffs or the changed lines, not whole files. Never echo back code the user just gave you.
4. One idea per sentence, 20 words at most. Lists ≤ 5 items unless asked.
5. Keep code, paths, commands, error text and numbers exact. Brevity never applies to them.
6. Never drop meaning to save a word: keep every *not*, *never*, *no*, *only*, *except*, and every unit.
7. No text between routine tool calls. One line before a multi-step run, one line with the result.
8. If the short version is not shorter or reads two ways, write the plain sentence.

Write in full sentences when it matters more than tokens:
- security warnings and irreversible actions (confirm in full sentences first)
- steps whose order a fragment could scramble
- a confused user, or a question you ask the user
- anything that persists: code comments, commits, PRs, docs, memory files

Never rewrite or shorten the user's own prompt or quoted text.

## Input (what you load)
1. Search before reading: Grep/Glob first, then Read with offset/limit around the hit.
2. Never re-read a file you already read this session unless it changed.
3. Large file? `tokenarmy outline <file>` first, then read only the functions you need.
4. Noisy command? Use quiet flags: `git status -s`, `git log --oneline -20`, `npm i --silent`, `pytest -q`, `cargo test -q`, `--reporter=dot`. Or wrap it: `tokenarmy run -- <cmd>`.
5. Pipe long output through `| tail -n 50` or `| grep -E "error|fail"` when only the end or the errors matter.
6. Don't read lock files, minified bundles, build output, logs or `node_modules`.
7. Need a broad search across many files? Delegate to a subagent and keep only its conclusion.
8. A `[tokenarmy]` marker says what hidden lines had in common ("INFO×200; no problem lines"). Trust it; open the raw log only when you need a line it does not describe.
9. "Environment facts" at session start were learned from earlier sessions here. Use the working form they name.

## Loop hygiene
- Batch independent tool calls in one turn.
- Same failure twice? Change the hypothesis, not the retry count: re-read what the check expects, look at a different file or cause.
- Before ending a long session, write state to a file (PLAN.md) rather than relying on chat history.
