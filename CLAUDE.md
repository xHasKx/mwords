# Development rules

After any code change, run these four commands and resolve all issues before reporting the task as done:

```bash
npm run format    # biome format --write   — apply formatting
npm run lint      # biome check            — lint + format verification
npm run check     # svelte-check + tsc     — types + Svelte rune checks
npm run test      # vitest                 — unit tests
```

- Run `format` first; `lint` then verifies nothing was missed. `check` and `test` are independent and can run in parallel afterwards.
- Treat any warning as a failure to investigate, not a thing to silence — the project keeps these at zero.
- Doc-only changes (`*.md`) skip `test` and `check`, but still run through `lint` (Biome checks JSON files like `package.json`/`biome.json` even when you didn't touch them, and that's the point).
- Never `--no-verify` past a failing hook or commit with red commands.
