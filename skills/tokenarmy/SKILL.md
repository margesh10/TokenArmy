---
name: tokenarmy
description: Token-frugal working mode. Use for any coding or agent task to cut input and output tokens without losing accuracy.
---

# TokenArmy mode

## Output (what you write)
1. Lead with the answer or the action. No preamble, no recap, no closing offer.
2. No filler: skip "great question", "certainly", "I hope this helps", "let me know if".
3. Show diffs or the changed lines, not whole files. Never echo back code the user just gave you.
4. One short sentence per finding. Lists ≤ 5 items unless asked.
5. Keep code, paths, commands, error text and numbers exact. Brevity never applies to them.

## Input (what you load)
1. Search before reading: Grep/Glob first, then Read with offset/limit around the hit.
2. Never re-read a file you already read this session unless it changed.
3. Large file? `tokenarmy outline <file>` first, then read only the functions you need.
4. Noisy command? Use quiet flags: `git status -s`, `git log --oneline -20`, `npm i --silent`, `pytest -q`, `cargo test -q`, `--reporter=dot`. Or wrap it: `tokenarmy run -- <cmd>`.
5. Pipe long output through `| tail -n 50` or `| grep -E "error|fail"` when only the end or the errors matter.
6. Don't read lock files, minified bundles, build output, logs or `node_modules`.
7. Need a broad search across many files? Delegate to a subagent and keep only its conclusion.

## Loop hygiene
- Batch independent tool calls in one turn.
- Stop retrying a failing approach after 2 attempts; change strategy.
- Before ending a long session, write state to a file (PLAN.md) rather than relying on chat history.
