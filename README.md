# TokenArmy 🪖

**Save tokens everywhere.** TokenArmy is a zero-dependency toolkit (Node ≥ 18) for Claude Code, Codex, Cursor and any LLM agent. It compresses tool output, strips AI slop, packs RAG context to a token budget, and audits where your setup wastes context.

Built by **Margesh**. MIT licensed.

## Install
```bash
git clone https://github.com/margesh10/TokenArmy && cd TokenArmy
npm link            # puts `tokenarmy` on your PATH
tokenarmy init      # Claude Code hook for this project (--global for all, --skill for terse mode)
tokenarmy audit     # find the leaks
```

## Where tokens are wasted (most to least)
| Sink | Why it hurts | TokenArmy fix |
|---|---|---|
| Shell output (tests, installs, builds, git) | Appended to history and resent on every later turn | PostToolUse hook / `tokenarmy run --` |
| MCP tool schemas | 10k–40k tokens per big server, every turn | `audit` flags them; use lazy tool loading or CLIs |
| CLAUDE.md / AGENTS.md | Sent with every request | `compress`, `slop --fix`, `templates/` |
| Whole-file reads | Agents read 2k lines to change 3 | `outline`, deny rules in `templates/settings.json` |
| Cache busting | A changing timestamp at the top of the prompt makes every call full price | `audit` detects volatile text |
| Slop in output | Filler such as "Great question!" and recaps | `skills/tokenarmy/SKILL.md` |
| RAG over-retrieval | Top-k chunks are often duplicates | `pack` (BM25 + MMR + budget) |

## Commands
```
tokenarmy count file.md
tokenarmy run -- npm test                 # works with any agent
cat build.log | tokenarmy squeeze --cmd "cargo build"
tokenarmy slop README.md [--fix --write]
tokenarmy compress CLAUDE.md --level 2 --write   # writes a .bak first
tokenarmy outline src/big.ts
tokenarmy pack docs --query "how does auth refresh" --budget 3000
tokenarmy graph src --seed src/api.ts --hops 2
tokenarmy gain
```

## Safe by design
- **Never rewrites or auto-approves commands.** rtk uses a PreToolUse rewrite hook; TokenArmy compresses only *after* the command runs, and never returns `permissionDecision`.
- **Lossless recovery.** Every compressed output saves the raw log to `~/.tokenarmy/raw/`, and the agent is given its path.
- **Signal never dropped.** Lines containing error, fail, panic, traceback and similar always survive; filters fall back to generic compression if they would lose one.
- **Code is untouchable.** Slop removal and prompt compression mask code blocks, inline code, URLs and quoted strings.
- **Opt out** per command with `# raw`, or globally with `TOKENARMY_OFF=1`. Stats stay on your machine.

## Deep dive
[docs/PATTERNS.md](docs/PATTERNS.md) covers the session cost model, prompt caching, context budgets, retrieval, code graphs, prompt and loop patterns, and what's coming next.

## Prior art (credit where due)
[rtk](https://github.com/rtk-ai/rtk) (CLI output filtering) · [LLMLingua](https://www.microsoft.com/en-us/research/project/llmlingua/) (Microsoft, learned prompt compression) · [caveman](https://github.com/JuliusBrussee/caveman) (terse output) · [i-have-adhd](https://github.com/ayghri/i-have-adhd) (action-first replies) · [ponytail](https://github.com/DietrichGebert/ponytail) (write less code) · [stop-slop](https://github.com/hardikpandya/stop-slop) and slop-detector (anti-slop) · ccusage (usage baseline).

Savings figures in those projects are self-reported. Measure your own with `tokenarmy gain` and Claude Code's `/context`. Token counts here are heuristic estimates (±15%).

## Develop
`npm test` runs the 16 tests with `node:test`.
