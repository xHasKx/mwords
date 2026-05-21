# mwords — Design

A browser-only Anki-like flashcard app for language learning. All persistent state
lives in retained topics on an MQTT broker; the only thing in `localStorage` is the
broker connection info.

## Goals

- **Frontend-only.** Runs on `localhost` during dev and on GitHub Pages in production.
  No backend service of our own — the MQTT broker plays the role of the data store.
- **Groups (decks).** Words are organised into named groups — one connection
  to a broker can host many of them ("German A1", "Spanish verbs", …). Groups
  are discovered from the broker on connect; the user picks one or creates
  a new one before reviewing/editing.
- **Two modes.**
  - **Review** — show a word, hide its translation, let the user grade recall
    (`Again` / `Hard` / `Good` / `Easy`).
  - **Edit** — list, add, edit, and delete words.
- **Three scheduling algorithms**, selectable from settings:
  - **SM-2** (default) — classic spaced-repetition.
  - **Weighted random** — pick any word, weighted by recent difficulty. No due dates.
  - **Serial** — walk the deck in the list's natural order. No scheduling logic.

  See [srs.md](./srs.md) for details. The choice is stored in the settings topic
  (see [data-model.md](./data-model.md)) so it follows the user across devices.
- **Sync via MQTT retain.** Words, per-card progress, and settings are each in their
  own retained topic. Opening the app on a second device replays all retained
  messages and the UI reconstructs identical state.
- **Small bundle, simple deploy.** GitHub Pages, single SPA, no service worker for v1.
- **Mobile-first UI.** Primary target is a mobile browser (one-handed use during
  spare moments). Desktop is supported via the same touch-driven layout — no
  keyboard shortcuts, no separate desktop interaction model.

## Stack

| Concern              | Choice                           | Why                                                                 |
|----------------------|----------------------------------|---------------------------------------------------------------------|
| Language             | TypeScript (strict)              | Type-safe MQTT payloads + SRS state.                                |
| UI framework         | **Svelte 5** (runes)             | Tiny runtime, single-file components, low ceremony for a 2-mode app.|
| Build / dev server   | **Vite**                         | First-class TS + Svelte support, instant HMR, easy GH Pages output. |
| MQTT client          | **mqtt.js** (`mqtt` on npm)      | De-facto standard, supports WSS in the browser, auto-reconnect.     |
| Offline queue store  | **idb** (`idb` on npm)           | ~2 KB Promise wrapper over IndexedDB; cursors for in-order flush.   |
| Routing              | Hash-based, hand-rolled          | Only 3 views (Review / Edit / Settings). No router lib needed.      |
| Styling              | Plain CSS, Svelte scoped styles  | Avoids a CSS-in-JS dependency; scoped-by-default is enough.         |
| Test runner          | Vitest                           | Native Vite integration; runs the pure SRS module in node.          |
| Lint + format        | Biome                            | One tool for both, fast, zero-config-ish.                           |
| Deploy               | GitHub Actions → GitHub Pages    | `vite build` → `dist/` → `actions/deploy-pages`.                    |

### Why not React?

React is the most familiar option, but for this app:

- Bundle: React + ReactDOM is ~45 KB min+gz before our code; Svelte ships ~10–15 KB.
- A Svelte component is HTML + `<script lang="ts">` + scoped CSS in one file — no
  hook rules, no `useEffect` dependency arrays, no memoization. The whole app is
  small enough that the React ecosystem advantage doesn't pay off.

### Why MQTT retain (and not, say, IndexedDB + sync)?

The user already wants MQTT as the source of truth. Retain semantics give us
"last-write-wins per topic" persistence for free — every retained topic is one
durable key/value pair, and a fresh subscriber receives the full snapshot on
connect. This matches the data shape (per-word records) very cleanly.

Trade-offs we accept:

- **No history / no conflict resolution.** Concurrent edits on two devices race;
  the later publish wins. For a single-user learning app this is fine.
- **Broker availability == app availability.** If the broker is down, the user
  can't sync. We mitigate by keeping a local cache (see "Offline behavior").
- **Per-word topics scale linearly.** Thousands of words → thousands of retained
  topics. Brokers like Mosquitto, EMQX, and HiveMQ handle this comfortably.

## High-level architecture

```
┌────────────────────────────────────────────────────────────────┐
│                            UI layer                            │
│  Svelte components: ReviewCard, WordEditor, ConnectionForm,    │
│  SettingsPanel, …                                              │
└──────────────────────────┬─────────────────────────────────────┘
                           │ reads/writes
                           ▼
┌────────────────────────────────────────────────────────────────┐
│                       Reactive stores                          │
│  $state-backed: connection, words, srsState, settings          │
└──────────┬────────────────────────────────────┬────────────────┘
           │ publishIntent(topic, payload)      │ subscribes
           ▼                                    │
┌─────────────────────────┐                     │
│   PublishQueue          │                     │
│  in-memory + IndexedDB  │                     │
│  (idb), dedupe by topic │                     │
└──────────┬──────────────┘                     │
           │ drains while connected             │
           ▼                                    ▼
┌─────────────────────────┐         ┌───────────────────────────┐
│   MQTT client wrapper   │◀────────│  Pure SRS engine          │
│  (mqtt.js + topic       │         │  sm2.ts, weighted.ts,     │
│   helpers + serializer) │         │  serial.ts, picker.ts     │
└──────────┬──────────────┘         └───────────────────────────┘
           │
           ▼
   wss://broker (retained topics under `mwords/<deck>/…`)
```

Key invariants:

- The **SRS engine** is pure: `(state, grade) → newState` and `(words, srsState, settings) → nextWord`.
  No DOM, no MQTT, no time except what the caller passes in. This makes it trivially testable.
- The **MQTT wrapper** is the only module that knows about `mqtt.js`. UI never imports `mqtt` directly.
- **Stores** own the in-memory mirror of MQTT state. UI components subscribe to
  stores via Svelte runes; user actions call store methods which optimistically
  update local state and enqueue a publish.
- The **PublishQueue** sits between stores and the MQTT wrapper. Stores never
  call `client.publish` directly — they call `queue.publishIntent(topic, payload)`,
  and the queue decides whether to flush now or hold until reconnect.

## File layout

```
mwords/
├── docs/                           # this folder
│   ├── design.md
│   ├── data-model.md
│   └── srs.md
├── public/
│   └── favicon.svg
├── src/
│   ├── main.ts                     # entry point, mounts <App />
│   ├── App.svelte                  # top-level shell + view switcher
│   ├── app.css                     # global resets, CSS vars
│   │
│   ├── lib/
│   │   ├── mqtt/
│   │   │   ├── client.ts           # MqttClient wrapper around mqtt.js
│   │   │   ├── queue.ts            # PublishQueue: idb-backed, dedupe by topic
│   │   │   ├── topics.ts           # topic-string builders + parsers
│   │   │   └── types.ts            # ConnectionState, Credentials, etc.
│   │   │
│   │   ├── srs/
│   │   │   ├── sm2.ts              # SM-2 algorithm (pure)
│   │   │   ├── weighted.ts         # weighted-random picker (pure)
│   │   │   ├── picker.ts           # dispatch on settings.srsMode
│   │   │   └── types.ts            # Grade, SrsState, etc.
│   │   │
│   │   ├── storage/
│   │   │   └── credentials.ts      # localStorage get/set/clear
│   │   │
│   │   ├── stores/
│   │   │   ├── connection.svelte.ts  # $state, connect/disconnect
│   │   │   ├── groups.svelte.ts      # discovered groups + active group
│   │   │   ├── words.svelte.ts       # Map<id, Word>, CRUD via MQTT
│   │   │   ├── srs.svelte.ts         # Map<id, SrsState>
│   │   │   └── settings.svelte.ts    # Settings record (global)
│   │   │
│   │   └── types.ts                # shared domain types (Word, Settings)
│   │
│   ├── components/
│   │   ├── ReviewCard.svelte
│   │   ├── GradeButtons.svelte
│   │   ├── WordList.svelte
│   │   ├── WordEditor.svelte
│   │   ├── ConnectionForm.svelte
│   │   ├── ConnectionBadge.svelte  # tiny "connected/disconnected" indicator
│   │   ├── GroupListItem.svelte
│   │   ├── SettingsPanel.svelte
│   │   └── NavBar.svelte
│   │
│   └── views/
│       ├── GroupPickerView.svelte
│       ├── ReviewView.svelte
│       ├── EditView.svelte
│       └── SettingsView.svelte
│
├── tests/
│   ├── sm2.test.ts
│   ├── weighted.test.ts
│   ├── serial.test.ts
│   ├── topics.test.ts
│   └── queue.test.ts
│
├── .github/workflows/deploy.yml    # build + deploy to Pages
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── svelte.config.js
├── biome.json
└── README.md
```

### Why this split

- `lib/srs/`, `lib/mqtt/`, `lib/storage/` are framework-agnostic. They'd survive a
  rewrite from Svelte to anything else.
- `lib/stores/` is the Svelte-specific glue (uses `$state` runes). The `.svelte.ts`
  extension is Svelte 5's convention for files that use runes outside components.
- `components/` are small and reusable; `views/` are page-level compositions.
- `tests/` only covers the pure modules. Component testing isn't worth the
  setup for v1 — the components are mostly markup.

## Application lifecycle

1. **Boot.** `main.ts` mounts `<App />`.
2. **Read credentials** from `localStorage` (`mwords:connection`). If missing
   or invalid → render `ConnectionForm`.
3. **Connect** to the broker via WSS using `mqtt.js`. A small connection
   badge in the nav bar reflects state (`connecting` / `connected` /
   `reconnecting in Ns` / `error`). In the `reconnecting` state the badge
   shows a live countdown to the next attempt (see "Reconnect strategy"
   below for how the interval is computed). **The badge is non-blocking** —
   connection happens in the background and never gates the UI. Edits made
   while disconnected go through the PublishQueue and drain on reconnect.
4. **Discover groups and load global settings.** In a single SUBSCRIBE,
   register `<P>/g/+` (single-level wildcard under the groups namespace)
   and `<P>/settings`. Retained `Group` payloads stream into the groups
   store keyed by id (the topic suffix `<G>`); the retained `Settings`
   payload streams into the settings store (or defaults are used if absent).
   Both subscriptions stay active for the lifetime of the connection so
   changes from other devices — new groups, renames, settings changes —
   propagate live.
5. **Select a group.**
   - If `lastGroup` (an id like `"1716285234567"`) is set in `localStorage`
     and resolves to a discovered group → **auto-select it** and skip the
     picker. This is the warm path.
   - Otherwise → render `GroupPickerView`. The user picks an existing group
     or types a name and creates a new one. Creation allocates a fresh id
     (`Date.now().toString()`), publishes the `Group` marker via the
     PublishQueue, and auto-switches to the new group. For an empty broker
     with no groups yet, the picker opens in "create" mode by default.
   - A "switch group" affordance from the nav bar returns the user to the
     picker at any time.
6. **Subscribe to the active group.** Subscribe to:
   `<P>/g/<G>/words/+` and `<P>/g/<G>/srs/+`. Retained messages flood in
   and populate the words / srs stores. (Settings are already loaded from
   phase 1 and are global, so they're not re-subscribed here.) The app
   transitions to **"synced"** only when **both** of the following are true:
   - **SUBACK received** for the two-topic SUBSCRIBE. This is the broker's
     confirmation that our subscriptions are registered and retained replay
     (if any) is in progress. Before SUBACK we can't tell "no messages yet"
     from "broker hasn't started sending."
   - **Debounce elapsed** — a short window (e.g. 250 ms) with no incoming
     messages. MQTT has no "end of retained" marker, so the debounce is the
     closest signal we get to "replay is done." The timer starts on whichever
     comes later: SUBACK, or the most recent retained message.

   For an empty group the debounce simply runs out 250 ms after SUBACK and
   we go straight to "synced." "Synced" is a badge nuance, not a UI gate —
   the user is never made to wait for it. Persist the chosen group to
   `localStorage.lastGroup` once subscription succeeds.
7. **Default view** is `Review` if there's at least one due word, else `Edit`.
8. **User actions** call store methods, which:
   - Optimistically update local state.
   - Hand the publish off to the **PublishQueue** (`queue.publishIntent`).
     The queue persists the intent to IndexedDB and — if connected — flushes
     it to the broker immediately with QoS 1 and `retain: true`. If
     disconnected, it stays put until reconnect.
9. **On reconnect**, mqtt.js resubscribes automatically (the phase-1
   discovery + settings subs and the phase-2 group-scoped subs); retained
   snapshots re-flood the stores. We diff against local state and reconcile
   (last-write-wins based on payload `updatedAt`). The PublishQueue drains
   any pending intents.
10. **Switching groups** unsubscribes the two group-scoped filters, clears
    the words/srs stores, then runs steps 6–7 for the new group. The
    discovery subscription and global settings subscription are untouched —
    settings persist across group switches.

## Connection form

- Three fields: WebSocket URL (e.g., `wss://broker.example.com:8884/mqtt`),
  username, password.
- Optional fourth: **base prefix** (default `mwords`). A single topic segment
  with no `/`, `+`, `#`, or null bytes. This namespaces the app on a shared
  broker. The group is **not** entered here — it's chosen at runtime in the
  next step.
- "Save & connect" persists to `localStorage` and triggers step 3 above.
- "Disconnect / forget" clears the credentials (and `lastGroup`).

## Group picker

- Listed alphabetically by group name. Each row shows the name only — no
  counts, due-today badges, or other stats. Keeps the picker fast (no need
  to pre-subscribe to every group's words just to render the list) and the
  UI uncluttered.
- **Each row has an inline "edit" affordance** (pencil icon, tap-to-rename).
  Tapping it switches the row into rename mode with the current name in a
  text input; submitting publishes a new `Group` to the same `<P>/g/<G>`
  topic with the updated `name` (and the unchanged `created`). Cancel just
  reverts the UI. See the name rules in [data-model.md](./data-model.md):
  up to 256 Unicode characters, any chars allowed, leading/trailing
  whitespace trimmed.
- "Create new group" inline input at the bottom. Same name rules apply. On
  submit, allocates a fresh id (`Date.now().toString()`), publishes the
  `Group` marker via the PublishQueue, and auto-switches to the new group.
- Group deletion is **not in v1**; no delete affordance.
- Reachable any time via a "switch group" entry in the nav bar. Switching
  is cheap — only the two group-scoped subscriptions change.

## Offline behavior

The MQTT broker is the source of truth, but connectivity is unreliable —
the user may close their laptop, lose Wi-Fi, or refresh the tab while a
review or edit is in flight. mwords stays usable offline through an
application-level **PublishQueue** layered on top of `mqtt.js`.

### Why not lean on mqtt.js + persistent sessions?

`mqtt.js` auto-reconnects (at a fixed interval by default — see "Reconnect
strategy" below for what we actually use) and holds an in-memory queue of
unacked QoS 1/2 publishes between disconnect and reconnect — but that queue
is lost if the tab is closed or reloaded. The MQTT protocol's
`cleanSession: false` / Session Expiry handles only the **incoming** side
(broker-buffered messages for our subscriptions). It does not preserve
publishes the client wanted to send but couldn't.

Because all our durable state is in **retained** topics, every fresh
subscription replays the latest values regardless of session state. So we
deliberately use `clean: true` and handle outbound durability ourselves.

### Reconnect strategy

`mqtt.js` does **not** do exponential backoff by default — it retries at a
constant `reconnectPeriod` (default 1000 ms) forever. That's too aggressive
for a dead broker and wastes battery on mobile. We override it by mutating
`client.options.reconnectPeriod` between attempts:

- **Start at 1 s.** First retry happens quickly so transient blips
  (network handover, brief WS proxy hiccup) recover instantly.
- **Double on each failed attempt** — 1 s → 2 s → 4 s → 8 s → 16 s.
- **Cap at 30 s.** Beyond that the broker is probably down for real and
  there's no benefit to retrying more often.
- **Apply ±20% jitter** so multiple tabs/devices don't all retry on the
  same tick after a shared outage (small-scale thundering herd).
- **Reset to 1 s on a successful `connect` event**, so the next disconnect
  starts the backoff fresh rather than picking up where it left off.

Concretely (in `lib/mqtt/client.ts`):

```ts
const MIN = 1000, MAX = 30_000;
let next = MIN;
client.on('reconnect', () => {
  client.options.reconnectPeriod = next;
  next = Math.min(MAX, next * 2);
  next = Math.round(next * (0.8 + Math.random() * 0.4));
});
client.on('connect', () => { next = MIN; });
```

### Connection badge during reconnect

The badge has four states with the following text:

| State              | Badge text                       |
|--------------------|----------------------------------|
| `connecting`       | `Connecting…`                    |
| `connected`        | `Connected` (or just a dot)      |
| `reconnecting`     | `Reconnecting in Ns` (countdown) |
| `error`            | `Disconnected` + retry button    |

The countdown:

- On `close` / `offline`, record `nextAttemptAt = Date.now() + next` (where
  `next` is the current backoff value above).
- A 1 Hz `setInterval` re-renders the badge while in `reconnecting`,
  showing `Math.max(0, Math.ceil((nextAttemptAt - Date.now()) / 1000))`.
- When `reconnect` fires (mqtt.js is actively dialling), switch the text to
  `Reconnecting…` until either `connect` (back to `Connected`) or `close`
  (start a new countdown with the new, doubled `next`).
- On `connect`, clear the interval and reset `next = MIN`.

Tapping the badge in any non-connected state offers a "Retry now" action,
which forces an immediate `client.reconnect()` and resets `next` to `MIN`.
This is the user's escape hatch when they know the network just came back
and they don't want to wait the remaining seconds.

### PublishQueue (`lib/mqtt/queue.ts`)

A small module sitting between the stores and the MQTT client. Backed by
IndexedDB via the `idb` library.

**Shape:** an `intents` object store keyed by an auto-incremented sequence
number, with this record:

```ts
type PublishIntent = {
  seq: number;             // auto-key; preserves enqueue order
  topic: string;
  payload: Uint8Array;     // serialized payload (empty array = tombstone)
  retain: boolean;
  qos: 0 | 1;
  enqueuedAt: number;      // epoch ms (Date.now())
  tabId: string;           // client/tab that enqueued it
};
```

**Behaviour:**

- `publishIntent(topic, payload, opts)`:
  1. Dedupe — if an unflushed intent for the same `topic` already exists,
     **replace** it. This matches retained semantics: only the latest payload
     per topic matters, intermediates are noise.
  2. Write to IDB.
  3. If connected, schedule a flush (microtask debounce).
- `flush()` is called on reconnect and after each `publishIntent`:
  1. Open a cursor over `intents` in `seq` order.
  2. For each: call `mqtt.publish(topic, payload, { qos: 1, retain })`.
  3. On the PUBACK callback (`mqtt.js` invokes our callback after broker ack),
     delete that record from IDB. **Not** on synchronous return — that only
     means it left the client.
  4. On publish error, stop flushing; mqtt.js's auto-reconnect will trigger
     another flush attempt later.
- `clear()` empties the queue (used on "Disconnect / forget").
- Cap: 10,000 entries. Beyond that, refuse new intents and surface a banner —
  guards against runaway queueing if the broker stays dead.

### Multi-tab handling

IndexedDB is shared across tabs of the same origin. Two tabs would otherwise
race to drain the queue and double-publish. Mitigations:

- Each tab generates a `tabId` (UUID, kept in `sessionStorage`).
- A `BroadcastChannel('mwords-leader')` is used to elect a single "leader"
  tab that owns flushing. New tabs start as followers and only flush their
  own intents through the leader's channel, or take over leadership if no
  heartbeat is received within ~2s.
- Followers still write intents to IDB (so they survive a tab close), but
  they don't call `mqtt.publish` directly.

If this turns out to be more complexity than warranted in practice, the v1
fallback is "only the foreground tab drains, every tab writes" — accept
occasional double-publishes (retain + LWW makes them harmless, just wasteful).

### Read-side staleness

While offline, the in-memory stores are stale relative to any other device
that edited in the meantime. On reconnect, retained messages re-flood the
stores. Reconciliation rule: an incoming payload with a newer `updatedAt`
overwrites the local copy; otherwise it's ignored. The pending publish in
our queue, when flushed, carries our local `updatedAt` — and if that's newer
than the broker's current retained value, ours wins. Same LWW semantics in
both directions.

### Caveats

- The user must **open the tab** for the queue to drain. We're not shipping
  a service worker in v1, so the queue doesn't sync in the background.
- Tombstones (deletions) are zero-byte payloads. The queue must store an
  empty `Uint8Array` faithfully and not treat it as "missing payload".
- If the user clears site data, IndexedDB goes with it — unflushed intents
  are lost. Acceptable: this is the same blast radius as `localStorage`.

## UI design

Mobile-first. The app is designed to be used on a phone, in portrait, often
one-handed; desktop is a secondary target.

### Layout principles

- **Single column at all sizes.** No multi-column dashboards. On wide screens
  the content centers within a max-width (~640 px) container so it stays
  readable, with whitespace on the sides rather than a separate desktop layout.
- **Bottom nav bar.** The view switcher (Review / Edit / Settings) and
  connection badge live in a sticky bottom bar — thumbs reach the bottom of a
  phone screen more easily than the top.
- **Safe-area insets.** Use `env(safe-area-inset-*)` for the bottom nav and
  any fixed elements, so they clear iOS notches and the home-bar gesture area.
- **Viewport meta tag.** `width=device-width, initial-scale=1,
  viewport-fit=cover` — required for safe-area handling and to prevent the
  iOS auto-zoom on input focus (which also needs ≥ 16 px input font-size).
- **No horizontal scroll, ever.** Long word/translation strings **always
  wrap** to additional lines. No truncation, no ellipsis, no reveal-on-tap
  for overflow — the full text is always visible. Card height grows to
  accommodate. CSS-wise this means `overflow-wrap: anywhere` on text
  containers and no fixed heights on card/list-row elements.

### Touch interactions (Review mode)

- **Tap the card** to reveal the translation. Whole-card hit area, not just a
  button — easier to hit one-handed.
- **Grade buttons** are a horizontal row, full-width, evenly spaced. Minimum
  hit target **48 × 48 CSS px** (per Material guidance; WCAG 2.5.5 says
  44 × 44, 48 gives margin). Buttons are labeled with both the word
  (`Again` / `Hard` / `Good` / `Easy`) and the SM-2 next-interval estimate
  (e.g. `Good · 6d`) so the user can decide without re-reading the algorithm.
- **No hover-only affordances.** Anything discoverable on hover must also be
  reachable by tap. Tooltips become tap-to-reveal popovers.
- **No swipe gestures in v1.** They conflict with browser back-navigation on
  iOS Safari and add complexity. Tap is the only interaction. Reconsider for v2.

### Edit mode on mobile

- Word list is a vertical scroll of cards, each showing `text` / `translation`
  with a tap target for the whole row.
- "Add word" is a sticky floating action button (bottom-right, above the nav bar).
- Editing uses a full-screen modal sheet, not an inline expand — small screens
  don't have room for inline editing without losing context.
- The form uses native `<input>` and `<textarea>` (no custom rich editors).
  `inputmode` and `autocapitalize` attributes set per field; specifically
  `autocapitalize="off"` on the source-language field if it's known not to need it.

### Performance budget

Mobile data + older devices, so:

- Target **< 100 KB** total transfer (gzipped) for the initial load. Svelte +
  mqtt.js + idb should fit comfortably.
- No web fonts in v1 — system font stack (`-apple-system, Segoe UI, Roboto, …`).
- No animations that block the main thread for more than 16 ms.

### Accessibility

- Color contrast meets WCAG AA against both light and dark backgrounds.
- Respect `prefers-color-scheme` for an automatic dark theme; allow override
  in settings later.
- Respect `prefers-reduced-motion` and skip the card-flip animation when set.
- Every interactive element has an accessible name.

## Dev workflow

```bash
npm install
npm run dev         # vite dev server, default http://localhost:5173
npm run test        # vitest
npm run check       # svelte-check + tsc --noEmit
npm run lint        # biome check
npm run build       # produces dist/
npm run preview     # serve dist/ locally
```

For local MQTT during development, the simplest option is a public test
broker over WSS (e.g., `wss://test.mosquitto.org:8081`) or a local Mosquitto
configured with a WebSocket listener. Note: **the browser can only speak MQTT
over WebSocket** — TCP-only brokers won't work.

## Deployment (GitHub Pages)

- `vite.config.ts` sets `base: '/mwords/'` (matching the repo name).
- GitHub Actions workflow (`deploy.yml`) on push to `main`:
  1. `npm ci`
  2. `npm run build`
  3. `actions/upload-pages-artifact` with `path: dist`
  4. `actions/deploy-pages`

## Out of scope for v1

- Multi-user / shared decks (single user assumed; broker ACLs handle isolation).
- Conflict resolution beyond "last write wins".
- Importing/exporting Anki `.apkg` files.
- Audio, images, rich text on cards.
- A service worker / installable PWA.
- Analytics, telemetry.

These are all reasonable v2 additions and the architecture above doesn't preclude any of them.
