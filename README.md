# mwords — Anki-like flashcard web app backed by MQTT

**Disclaimer**: most of the code written by Claude Code.

<https://xhaskx.github.io/mwords/>

A simple browser-based, Anki-like flashcard app for language learning, with
spaced-repetition review and an editable word list. Words are organised
into a two-level hierarchy: **groups** at the top (a *language* or
*project* — "German", "Spanish") and **decks** inside them (study sets
like "A1 Verbs", "Food"). On first connect the user picks (or creates) a
group, then a deck, and Review can scope to a single deck, a selection
of decks, or every deck in the group.

**Design at a glance.** Frontend-only (Svelte 5 + Vite + TypeScript), no
backend service of our own. All persistent state — words, per-card SRS
state, settings, groups, decks — lives in retained topics on an MQTT
broker the user connects to over WSS. Only broker credentials are kept
in `localStorage`; an IndexedDB-backed publish queue lets edits made
offline sync once the broker is reachable again. Designed to be hosted
on GitHub Pages.

See [`docs/design.md`](./docs/design.md) for the full design,
[`docs/data-model.md`](./docs/data-model.md) for the MQTT topic and payload
schemas, and [`docs/srs.md`](./docs/srs.md) for the scheduling algorithms.

## Develop

```bash
npm install
npm run dev         # vite dev server, http://localhost:5173
npm run test        # vitest (pure SRS / queue modules)
npm run check       # svelte-check + tsc --noEmit
npm run lint        # biome check
npm run format      # biome format --write
```

For a local MQTT broker during development, point the connection form at a
WebSocket-enabled broker — e.g. a public test broker like
`wss://test.mosquitto.org:8081` or a local Mosquitto configured with a
WebSocket listener. Browsers can only speak MQTT over WebSocket.

## Build

```bash
npm run build       # produces dist/
npm run preview     # serve dist/ locally for a smoke test
```

`vite.config.ts` sets `base: '/mwords/'` to match the GitHub Pages
sub-path, so `npm run preview` serves the app at
`http://localhost:4173/mwords/` — not the root.

## Deploy

`master` is for ongoing commits and does **not** trigger Pages rebuilds.
A dedicated `release` branch drives deploys:

```bash
git push origin master:release   # fast-forward release; CI builds + deploys
```

The GitHub Actions workflow (`.github/workflows/deploy.yml`) triggers on
push to `release` (or via the Actions UI's "Run workflow" button), runs
`npm ci` and then `npm run build`, uploads `dist/` via
`actions/upload-pages-artifact`, and deploys it via `actions/deploy-pages`.
`release`'s HEAD is the "what's live" pointer; `git log master..release`
shows undeployed work.

One-time setup:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Settings → Environments → `github-pages` → Deployment branches
   and tags**: add `release` (or switch to *All branches*). GitHub
   seeds this list with `main`/`master` only, so a push from
   `release` is otherwise rejected at the deploy step with
   *"Branch is not allowed to deploy to github-pages due to
   environment protection rules."*
