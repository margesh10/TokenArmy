# Project rules
<!-- Keep this file < 1500 tokens: it is sent with EVERY request. Put details in docs/ and link them. -->
<!-- Never put dates, session ids or other changing text here: it breaks prompt caching. -->

## Stack
- <language/framework/version>
- Run: `<cmd>` · Test: `<cmd> -q` · Lint: `<cmd>`

## Rules the code can't tell you
- <non-obvious convention 1>
- <non-obvious convention 2>

## Token discipline
- Answer first, no preamble or recap. Diffs, not whole files.
- Grep before Read; Read with offset/limit. Don't re-read unchanged files.
- Use quiet flags (`-q`, `--silent`, `--oneline`, `-s`). Never read lock files, logs, dist/, node_modules/.

## More docs (read only when relevant)
- Architecture: docs/architecture.md
- Deploy: docs/deploy.md
