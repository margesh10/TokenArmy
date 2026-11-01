# Contributing

1. No runtime dependencies. Node ≥ 18 standard library only.
2. **Never drop signal.** A filter must keep every error or failure line, or return `null` to fall back to generic compression.
3. **Never touch code** in slop removal or prompt compression.
4. Every new filter needs a test in `test/` with real-looking output, asserting both what was removed and what was kept.
5. Report savings with `tokenarmy gain` or before/after token counts. No unmeasured claims.

New command filters go in `src/filters.js` as `{ name, cmd: /regex/, fn }` in `RULES`.
