# Changelog

All notable changes to TokenArmy. Dates are release dates (YYYY-MM-DD).

## 0.3.0 (2026-11-21)

### Added
- **GitHub Copilot** (VS Code agent mode, Copilot CLI): tool results are replaced through Copilot's `modifiedResult`; shell, file-view and grep results; project brief at session start. `tokenarmy init --agent copilot`.
- **Devin** (CLI, Desktop): project brief, learned facts and loop guard. Opt-in `--wrap` runs known-noisy, stateless shell commands through `tokenarmy run`, because Devin's hooks can't replace output. `tokenarmy init --agent devin [--wrap]`.
- `tokenarmy init --agent claude|copilot|devin|all [--global]`. When an agent also reads `.claude/settings.json`, each tool call is still handled once.
- `tokenarmy run --b64` runs a command byte-for-byte (quotes, pipes, exit code intact); `--agent` and `--session` record where it ran.
- Project brief at session start: commands that ran clean, files read in most sessions, failures still open (`tokenarmy brief`).
- Environment facts learned across sessions (`tokenarmy facts`).
- Elision markers say what they hid (levels, counts, ranges).
- Filters: terraform/tofu, gradle, mypy, more test runners (bun, deno, nextest, gotestsum, playwright).
- `audit` flags MCP servers that no recent session of the project used.
- Secrets are redacted from everything TokenArmy writes to disk, now including npm tokens, Azure connection-string keys and `*CREDENTIALS*` variables.
- Retention: raw outputs and session state older than 7 days are deleted (`TOKENARMY_KEEP_DAYS`).
- CI on Windows, macOS and Linux (Node 18, 20, 22), including a check that published benchmark numbers match the code.

### Fixed
- The loop guard called a *successful* command a repeated failure when it printed the same warning every run (e.g. `npm WARN deprecated`). Only real failures count now: error, failure, panic or traceback lines, or a non-zero exit code. Warnings, deprecations and "0 failed" never do.
- `cat data.json` (or `type` / `Get-Content`) was returned as a reshaped table, so an agent about to edit the file saw something else. JSON is now only reshaped for API and CLI responses (`curl`, `gh api`, `kubectl`, cloud CLIs, `--json` / `-o json`).
- The savings ledger grew forever and was read in full on every hook call and status-line refresh (+80 ms per call at 50k entries). It now rotates past 1 MB into running totals; `gain` stays all-time.
- Auto-bypass was global and permanent: a few raw-log opens in one project disabled that command's compression everywhere, forever. It is now per project and looks at the last 14 days (`TOKENARMY_BYPASS_DAYS`).
- Re-read notes now check themselves: a full re-read right after a note counts as a miss, and a project where notes keep missing stops getting them. The window is now 10 minutes (was 20).
- Devin wrap mode keeps the original command readable in a trailing comment.
- Fixture benchmarks used the live source tree as input, so the published numbers moved with every commit. They now use frozen snapshots in `bench/fixtures/`, and a re-run leaves the files unchanged.
- go test failure details printed before `--- FAIL` were dropped.

## 0.2.0 (2026-11-01)

### Added
- Search output grouped by file with counts (Grep tool, grep/rg/Select-String).
- File re-reads: an unchanged file becomes a one-line note, a changed one just the diff.
- JSON compression; filters for git diff/show/push/pull, ruff/flake8, build progress, docker ps / kubectl get.
- Loop guard on repeated identical failures.
- Compaction checkpoint (Claude Code): asks, changed files, commands and todos handed back after compaction.
- Commands the agent already narrowed (`| tail`, `| grep`) get lossless cleanup only.
- Learning loop: auto-bypass for compressions the agent keeps undoing; `tokenarmy learn` proposes noise filters.
- `tokenarmy ab` (controlled A/B on a real task), `expand`, `statusline`, `init --statusline`; Claude Code plugin manifest.

## 0.1.0 (2026-10-31)

- First release: Claude Code PostToolUse hook for command output, `run`, `squeeze`, `slop`, `compress`, `outline`, `pack`, `graph`, `audit`, `count`, `gain`; reproducible fixture benchmarks.
