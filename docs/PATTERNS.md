# Token engineering patterns

Ways to spend fewer tokens on context, retrieval, prompts and agent loops. Each pattern says what it costs, why it works and how to apply it.

---

## 1. The cost model you are actually paying

In an agent loop, turn *n* resends turns 1…n-1. Total input over a session is roughly:

```
Σ (system + tools + memory) · n   +   Σ tool_output_i · (n − i)
```

Two consequences:
- **Fixed preload** (system prompt, tool schemas, CLAUDE.md) is multiplied by turn count. Shrink it once and you save on every turn.
- **Early tool output is the most expensive token you have.** A 5k-token test log on turn 3 of a 40-turn session costs ~185k input tokens. Compressing it at the source (the PostToolUse hook) beats any later summarisation.

Output tokens cost 3-5× more each but are usually only 1-5% of a session's volume. Terse-output skills help cost a little; input discipline helps a lot.

## 2. Prompt caching: keep a stable prefix

Cached input is billed at ~0.1× when the prefix is byte-identical.
- Order context from **most stable to most volatile**: tools → system → memory files → retrieved docs → conversation → current turn.
- Never put timestamps, UUIDs, git SHAs or "today is…" in the stable prefix. (`tokenarmy audit` flags this.)
- Don't reorder tool definitions or MCP servers between turns.
- Compaction resets the cache. Compact rarely and deliberately, not every few turns.
- Cached tokens still occupy the window. Caching lowers the cost, not the attention load.

## 3. Context budgeting

Give every layer a hard budget and compress deterministically when a layer overflows. Don't let the model "see everything".

| Layer | Share of window | Overflow action |
|---|---|---|
| System + tools | 10-20% | Lazy tool loading, fewer MCP servers |
| Memory (CLAUDE.md) | ≤ 2% (~1.5k) | Move details to linked docs/skills |
| Retrieved context | 25-40% | `pack` with a budget (BM25 + MMR) |
| History | 30-40% | Clear old tool results first, then summarise |
| Working space | ≥ 15% | Leave headroom for the answer and reasoning |

Clearing stale tool results is the safest compaction: they are the largest and least reused part of history.

## 4. RAG that retrieves less

- **Chunk on structure** (headings, top-level functions), not at fixed sizes. Chunks then carry meaning, and fewer of them are needed.
- **Hybrid first stage:** lexical retrieval (BM25) is cheap, exact on identifiers and error strings, and often beats embeddings on code. Add dense retrieval only where vocabulary diverges.
- **MMR dedupe:** top-k lists are full of near-duplicates. Penalise similarity to chunks already picked.
- **Pack to a budget, not to a k.** A fixed k wastes tokens on easy queries and starves hard ones.
- **Ordering:** put the best chunk first and the rest in source order. Middle positions get the least attention.
- **Cite, don't paste:** give `path:line` ranges, so the agent can pull more on demand instead of preloading.

## 5. Graph engineering for code

Code is a graph (imports, calls, inheritance), so relevance follows **hop distance**, not just text similarity.
- Start at the file being edited, expand 1-2 hops over imports and reverse imports (`tokenarmy graph`), and include **outlines** (signatures only) for hop-2 files and full text only for hop 0-1.
- That one rule (full text near the seed, outlines further out) typically cuts repo context by 80-95%.
- Next step: rank neighbours by personalised PageRank, and weight call edges above import edges.

## 6. Prompt patterns

- **State rules once, positively and briefly.** "Always X" beats a paragraph of why. Put the why in docs.
- **Show the output format** with a tiny example instead of describing it.
- **Delete what the code already says** (stack, folder layout). The agent can read it when needed.
- **Prefer structure over prose** in instructions: bullets, short headings, no bold, no decoration (`compress --level 2`).
- **Telegraphic style for input** (`--level 3`) is fine for memory files the model reads. Don't use it for text humans maintain.

## 7. Loop patterns

- **Quiet tools by default:** `-q`, `--silent`, `--oneline`, `git status -s`, `--reporter=dot`.
- **Search → narrow → read:** Grep/Glob, then Read with offset/limit. Never read whole files speculatively.
- **Subagents as context firewalls:** broad exploration runs in a child context, and only its conclusion returns.
- **Circuit breakers:** after two failed attempts at the same approach, change strategy. Retry loops grow context quadratically.
- **State on disk:** long tasks keep PLAN.md / NOTES.md and resume from them, not from 200k tokens of chat.
- **Atomic tasks:** split a spec into tasks that each fit a small fresh session. A 5-10k-token task beats an 80k all-in-one session.
- **Route by difficulty:** cheap/fast models for search, summarise and format; frontier models for design and debugging.

## 8. Write less code

The cheapest tokens are the lines never generated, and never re-read in every later turn. Follow this order: YAGNI → reuse existing code → stdlib → platform built-ins → a dependency → new code (the ponytail ordering).

## 9. Future patterns to watch

- **Learned compression** (LLMLingua-2-style token classifiers) running locally before every API call.
- **Tool search / deferred schemas** as the default for MCP: load a tool's schema only when the agent asks for it.
- **Code-execution tool use:** the agent writes a script that calls many tools, so only the final result enters context.
- **KV-cache-aware context managers** that evict and compact while preserving the cached prefix.
- **Persistent memory graphs** that replace replaying history: entities, decisions and file facts retrieved per turn.
- **Per-turn context diffing:** send only what changed in a file since the agent last saw it.

---
Measure before and after: `tokenarmy gain`, Claude Code's `/context`, and ccusage on your own logs. Most published savings figures (including those of the tools credited in the README) are self-reported.
