# Agent rules (Codex, Copilot CLI, Gemini CLI, Cursor, etc.)
<!-- Same rules as templates/CLAUDE.md. Keep < 1500 tokens and free of changing text. -->

- Answer first. No preamble, recap or closing offer. Show diffs, not whole files.
- Search before reading; read line ranges, not whole files. Don't re-read unchanged files.
- Wrap noisy commands: `tokenarmy run -- <cmd>` (tests, installs, builds, git log).
- Use quiet flags: `-q`, `--silent`, `--oneline`, `git status -s`.
- Never read lock files, logs, minified bundles, dist/, build/, node_modules/.
- Reuse existing code and the stdlib before adding code or dependencies. The cheapest tokens are the lines you never write.
