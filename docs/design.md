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

- **No history; LWW conflict resolution.** Concurrent edits on two devices race;
  the later publish wins, both at the broker (retained overwrite) and at the
  client (timestamp-LWW gate). For a single-user learning app this is fine.
- **Broker availability == app availability.** If the broker is down, the user
  can't sync. We mitigate by keeping a local cache (see "Offline behavior").
- **Per-word topics scale linearly.** Thousands of words → thousands of retained
  topics. Brokers like Mosquitto, EMQX, and HiveMQ handle this comfortably.

## Broker requirements

mwords speaks **MQTT 5.0**. The broker must support v5 with a WebSocket
listener; v3.1.1-only brokers won't work. `mqtt.js` is configured with
`protocolVersion: 5` when connecting. Mosquitto ≥ 2.0, EMQX, HiveMQ, and
NanoMQ all support v5 in their default builds.

The one v5-only feature we rely on:

- **User Properties on PUBLISH packets.** Every publish carries a single
  `timestamp` User Property, derived at flush time:

  | Case                                  | `timestamp` value                                |
  |---------------------------------------|--------------------------------------------------|
  | Content publish with numeric `updated`| `payload.updated.toString()` (already seconds)   |
  | Tombstone (zero-byte payload)         | `(Date.now() / 1000).toString()` at flush time   |
  | Payload missing numeric `updated`     | `(Date.now() / 1000).toString()` at flush time   |

  Values may include fractional ms digits (e.g. `"1716285234.567"`) —
  full precision is preserved.

  Purpose: gives downstream consumers (other clients, server-side
  subscribers, logs, dashboards) a per-message timestamp at the protocol
  level — useful for sorting, debugging, and external integrations that
  don't speak our JSON schema.

We also rely on **retained messages** as the durable storage layer.

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
   wss://broker (retained topics under `<P>/settings` and `<P>/g/<G>/…`)
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
│   │   │   ├── serial.ts           # serial-order picker + compareWords (pure)
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
- `tests/` covers the pure modules only — components are mostly markup.

## Application lifecycle

1. **Boot.** `main.ts` mounts `<App />`.
2. **Read credentials** from `localStorage` (`mwords:connection`). If missing
   or invalid → render `ConnectionForm`.
3. **Connect** to the broker via WSS using `mqtt.js`, configured with
   `resubscribe: false` so our wrapper manages subscriptions
   explicitly (see step 9 for the reconnect path). A small connection
   badge in the nav bar reflects state (`connecting` / `connected` /
   `reconnecting in Ns` / `error`). In the `reconnecting` state the badge
   shows a live countdown to the next attempt (see "Reconnect strategy"
   below for how the interval is computed). **The badge is non-blocking** —
   connection happens in the background and never gates the UI. Edits made
   while disconnected go through the PublishQueue and drain on reconnect.

   On every successful `connect` event — both the initial boot
   connection and any later reconnect — the wrapper calls
   `await queue.drainAll()` before issuing any SUBSCRIBE. If
   `pendingCount === 0`, `drainAll()` resolves immediately. Otherwise
   it resolves once every currently-queued intent has been published and
   PUBACK'd (the queue removes each row from IDB inside the PUBACK
   callback). Only then does the wrapper move on to step 4 (or, on
   reconnect, step 9's re-subscribe). This guarantees retained replay
   always reflects our latest pending edits, so the LWW gate never has
   to defend against our own pre-flush state.
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
   - Otherwise → render `GroupPickerView`. If `lastGroup` was set but
     didn't resolve (e.g. the group was deleted from another client), it
     is cleared from `localStorage` at this point so we don't keep
     looking for it on every load. The user picks an existing group or
     types a name and creates a new one. Creation allocates a fresh id
     (`Date.now().toString()`), publishes the `Group` marker via the
     PublishQueue, and auto-switches to the new group. For an empty
     broker with no groups yet, the picker opens in "create" mode by
     default.
   - A "switch group" affordance from the nav bar returns the user to the
     picker at any time.
6. **Subscribe to the active group.** Subscribe to:
   `<P>/g/<G>/words/+` and `<P>/g/<G>/srs/+`. Retained messages flood in
   and populate the words / srs stores, gated by the timestamp-LWW check
   described in step 9. (Settings are already loaded from phase 1 and
   are global, so they're not re-subscribed here.) The app
   transitions to **"synced"** only when **both** of the following are true:
   - **SUBACK received** for the two-topic SUBSCRIBE. This is the broker's
     confirmation that our subscriptions are registered and retained replay
     (if any) is in progress. Before SUBACK we can't tell "no messages yet"
     from "broker hasn't started sending."
   - **Debounce elapsed** — a 500 ms window with no incoming messages.
     MQTT has no "end of retained" marker, so the debounce is the closest
     signal we get to "replay is done." 500 ms is a compromise: short
     enough to feel snappy on a healthy connection, long enough to ride
     out small pauses mid-replay on slower links. The timer starts on
     whichever comes later: SUBACK, or the most recent retained message.

   For an empty group the debounce simply runs out 500 ms after SUBACK and
   we go straight to "synced." "Synced" is a badge nuance — it doesn't
   block the UI; the user is never made to wait for it. Persist the
   chosen group by updating the `lastGroup` field inside the
   `mwords:connection` blob in `localStorage` once subscription succeeds.
7. **Default view** is `Review` if there's at least one due word, else `Edit`.
8. **User actions** call store methods, which follow a uniform pattern:
   1. **Optimistic store mutation first.** The Svelte `$state` is updated
      synchronously; the UI re-renders this microtask. The user sees the
      change immediately. The new record carries an `updated` field
      (`Date.now() / 1000`) that doubles as the LWW timestamp — see
      step 9. (The `timestamp` MQTT 5 User Property carried by every
      publish is also derived from this `updated` field; see "Broker
      requirements" — so on the wire and locally we compare the same
      epoch-seconds value.)
   2. **`await queue.publishIntent(...)` for commit-like actions** —
      Save (word create/edit), Settings change, group create, group
      rename, word/group deletion. The await catches *actionable*
      failures (10 k queue cap, IDB quota, IDB unavailable). On reject,
      the store reverts the optimistic mutation and surfaces an error
      banner. On resolve, the change is durable across reloads.
   3. **Non-commit actions** (e.g. recording an SRS grade in Review mode)
      don't await — they're cheap, frequent, and one occasional dropped
      grade isn't worth gating the next card on. Errors there are logged
      and counted but never block the UI.

   The actual broker round-trip is *not* part of this path. PUBACK
   happens later and only affects when the queue removes the record
   from IDB; the UI doesn't care.
9. **On reconnect**, the wrapper repeats the connect-time sequence: first
   `await queue.drainAll()` (see step 3), then re-issue the active
   subscriptions (the phase-1 discovery + settings filters plus the
   phase-2 group-scoped filters for the currently-active group).
   `mqtt.js` does **not** auto-resubscribe (`resubscribe: false` in step
   3) — the wrapper is the single source of subscription state.
   Retained snapshots then re-flood the stores. Each incoming message
   is gated by a **timestamp-LWW check** against our local state:

   - Every payload (`Group`, `Word`, `Settings`, `SrsState`) carries an
     `updated` field in epoch seconds — that field **is** the LWW
     timestamp. Topics are transient strings parsed by
     `lib/mqtt/topics.ts` to decide which store + which id an incoming
     message targets; once dispatched, the store's existing record (if
     any) supplies the local `updated`.
   - On incoming, read the `timestamp` MQTT 5 User Property and parse it
     as a `Number` — already in seconds. Compare directly against the
     local record's `updated` (also epoch seconds). For content publishes
     these two values are the *same* quantity (the sender's
     `payload.updated` was the source of the UP); for tombstones the UP
     is the sender's publish-time, still comparable to our local
     `updated`. One comparison, same unit.
   - If the parsed value is **less than** the local record's `updated`
     → **discard the incoming message**. Our local state is newer (and
     a matching intent is sitting in the queue waiting to flush).
   - Otherwise → accept it; the store entry is overwritten by the new
     payload (whose `updated` becomes the new local timestamp by virtue
     of being part of the record).
   - If the incoming has no `timestamp` UP, or we have no local record
     for this id yet, accept unconditionally.

   The PublishQueue then drains any pending intents, which become the
   broker's new retained values. After the next round-trip everyone
   converges on our newer state. This is the mechanism by which **edits
   made while disconnected win over the broker's stale retained values**
   on reconnect — without it, the retained replay would briefly overwrite
   the user's pending edits before the queue caught up.

   The same comparison is applied to all incoming messages, not just the
   reconnect-replay batch — incoming publishes from other devices during
   normal operation go through the same gate.
10. **Switching groups** is a **blocking** transition (unlike the initial
    boot in step 6, where the user is free to interact while retained
    messages stream in). The sequence:
    1. Enter a `switching` state. The UI overlays a full-screen
       "Switching to *{groupName}*…" spinner and ignores input on the
       Review / Edit views.
    2. Unsubscribe the two group-scoped filters for the previous group.
       Clear the words / srs stores.
    3. Subscribe the two group-scoped filters for the new group:
       `<P>/g/<G>/words/+` and `<P>/g/<G>/srs/+`.
    4. Wait for **SUBACK + the 500 ms debounce** (same rule as step 6).
       Retained `Word` and `SrsState` messages stream into the stores
       during this window.
    5. Update the `lastGroup` field inside the `mwords:connection`
       blob in `localStorage` and leave the `switching` state. The
       overlay disappears; the user lands on the default view (Review
       or Edit).

    The discovery subscription and global settings subscription are
    untouched — settings persist across group switches. Blocking the UI
    during the switch eliminates any race between the new group's
    retained replay and user input that would otherwise have to be
    defended against in the stores.

## Connection form

- Three fields: WebSocket URL (e.g., `wss://broker.example.com:8884/mqtt`),
  username, password.
- Optional fourth: **base prefix** (default `mwords`). Validated against
  the rules in [data-model.md](./data-model.md) → "LocalStorage"
  (`StoredConnection.prefix`). This namespaces the app on a shared broker.
  The group is **not** entered here — it's chosen at runtime in the next
  step.
- "Save & connect" persists to `localStorage` and triggers step 3 above.
- **"Clear pending queue"** — calls `queue.clear()` to drop every intent
  currently in IDB without touching `localStorage` (credentials, prefix,
  and `lastGroup` survive). Visible only when `pendingCount > 0`. Gated
  behind a confirmation prompt that shows the count (e.g. "Discard 7
  pending changes? They will not be sent to the broker."). Useful for
  recovering from a stuck queue, dropping a batch of edits the user
  doesn't want to sync, or general debugging. The broker remains the
  source of truth, so the in-memory store is reconciled by retained
  replay on the next subscribe cycle.
- "Disconnect / forget" deletes the `mwords:connection` key from
  `localStorage` (credentials, prefix, and `lastGroup` go with it) and
  also clears the queue. Strict superset of "Clear pending queue."

## Group picker

- Each row shows the group name only — no counts, due-today badges, or
  other stats. Order in v1 is "as discovered" (insertion order into the
  groups store from the retained replay); explicit sorting can be added
  later. The picker stays fast because we don't pre-subscribe to every
  group's words just to render the list.
- **Each row has an inline "edit" affordance** (pencil icon, tap-to-rename).
  Tapping it switches the row into rename mode with the current name in a
  text input; submitting publishes a new `Group` to the same `<P>/g/<G>`
  topic with the updated `name`, the unchanged `id` and `created`, and a
  fresh `updated` (`Date.now() / 1000`). Cancel just reverts the UI.
- "Create new group" inline input at the bottom. On submit, allocates a
  fresh id (`Date.now().toString()`), publishes the `Group` marker via
  the PublishQueue, and auto-switches to the new group.
- Both inputs validate the name against the rules in
  [data-model.md](./data-model.md) → "Group names (display only)".
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
  // Double, jitter ±20%, then clamp — so MAX is a hard ceiling.
  const doubled = next * 2;
  const jittered = doubled * (0.8 + Math.random() * 0.4);
  next = Math.min(MAX, Math.round(jittered));
});
client.on('connect', () => { next = MIN; });
```

### Connection badge during reconnect

The badge has four states. Each can optionally show a "pending count"
suffix sourced from `queue.pendingCount` — the number of intents currently
in IDB awaiting PUBACK. The suffix appears only when count > 0:

| State              | Badge text (no pending)          | Badge text (pending > 0)             |
|--------------------|----------------------------------|--------------------------------------|
| `connecting`       | `Connecting…`                    | `Connecting… · 3 pending`            |
| `connected`        | `Connected` (or just a dot)      | `Connected · 3 pending`              |
| `reconnecting`     | `Reconnecting in Ns` (countdown) | `Reconnecting in Ns · 3 pending`     |
| `error`            | `Disconnected` + retry button    | `Disconnected · 3 pending`           |

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
  payload: Record<string, unknown> | null;  // plain JS object, or null for a tombstone
  retain: boolean;
  qos: 0 | 1;
  enqueuedAt: number;      // epoch seconds (Date.now() / 1000)
  publishedAt?: number;    // epoch seconds; set the moment flush() calls
                           // mqtt.publish for this intent. Presence flags
                           // the intent as in-flight and exempts it from
                           // dedupe-replace (see Behaviour below).
};
```

IDB stores `payload` via the structured-clone algorithm — we put a plain
object in, we get a deep-cloned object back. Structured clone gives us
snapshot semantics automatically (caller mutating the original after
enqueue won't affect what we publish), so we don't pre-serialize to bytes
at enqueue time. JSON serialization happens once, at flush time.

The MQTT 5 `timestamp` User Property is **not** stored on the intent —
it's derived at flush time from the payload's `updated` field (see
`flush()` below).

**Public surface:**

```ts
publishIntent(topic, payload): Promise<void>;     // content publish
publishTombstone(topic):       Promise<void>;     // zero-byte retain (delete)
clear():                       Promise<void>;     // wipe queue (on Disconnect/forget)
drainAll():                    Promise<void>;     // resolves when pendingCount
                                                  // reaches 0 — every intent
                                                  // currently in IDB has been
                                                  // PUBACK'd and removed.
                                                  // Used by the connect handler
                                                  // before issuing SUBSCRIBE.

pendingCount: number;                             // reactive ($state); count of
                                                  // intents currently in IDB.
                                                  // Used by the connection badge.
```

Both `publishIntent` and `publishTombstone` resolve **as soon as the intent
has been persisted to IndexedDB** — they do *not* wait for PUBACK. UI
callers `await` them on commit-like actions (Save, Settings change, etc.)
to catch IDB failures (quota / queue cap / unavailable). Non-commit call
sites can fire and forget. The actual MQTT round-trip happens in the
background and never blocks the UI thread.

`pendingCount` is incremented when a new intent is written to IDB (or kept
flat when a dedupe-replace happens — same row, same count) and decremented
when a PUBACK callback deletes a record. It's the same number shown in the
connection badge.

**Behaviour:**

- `publishIntent` / `publishTombstone`:
  1. Dedupe — if an existing intent for the same `topic` exists **and is
     not in-flight** (its `publishedAt` is unset), **replace** it in place
     (same `seq`, new `payload`/`enqueuedAt`). If the existing intent **is**
     in-flight (`publishedAt` set), do not touch it — append a new row
     (fresh `seq`) instead. The in-flight one will be removed by its own
     PUBACK; the new row gets flushed on the next cursor pass. This
     guarantees a payload submitted to `mqtt.publish` is never quietly
     replaced before its PUBACK lands. Tombstones and content publishes
     dedupe each other (a later tombstone supersedes an earlier
     non-in-flight content publish on the same topic, and vice-versa).
  2. Write to IDB.
  3. If connected, schedule a flush (microtask debounce).
- `flush()` is called on `connect` (via `drainAll()`) and after each
  `publishIntent`:
  1. Open a cursor over `intents` in `seq` order. Skip rows already marked
     in-flight (`publishedAt` set) — they're already being awaited.
  2. For each remaining intent, derive bytes + `timestamp` User Property,
     mark the intent as in-flight, persist the marker, and call
     `mqtt.publish`:

     ```ts
     const bytes = intent.payload === null
       ? new Uint8Array(0)
       : new TextEncoder().encode(JSON.stringify(intent.payload));
     const tsSec = (intent.payload !== null
                    && typeof intent.payload.updated === 'number')
       ? intent.payload.updated                       // already seconds
       : Date.now() / 1000;                           // tombstone or no `updated`
     const timestamp = tsSec.toString();

     intent.publishedAt = Date.now() / 1000;
     await idb.put('intents', intent);                // persist the in-flight flag

     mqtt.publish(intent.topic, bytes, {
       qos: 1,
       retain: intent.retain,
       properties: { userProperties: { timestamp } },
     });
     ```
  3. On the PUBACK callback (`mqtt.js` invokes our callback after broker ack),
     delete that record from IDB by `seq` and decrement `pendingCount`. If
     `pendingCount` reaches 0, resolve any in-flight `drainAll()` promise.
     **Not** on synchronous return of `mqtt.publish` — that only means the
     packet left the client.
  4. On publish error, stop iterating; the row is left with its
     `publishedAt` marker until the next disconnect cycle.
- On mqtt.js's `close` (or `offline`) event, the wrapper clears
  `publishedAt` on every IDB row (a single bulk-update transaction). Any
  row that was in-flight when the connection dropped — PUBACK never
  arrived — is now eligible for re-flush on the next `connect`. Without
  this step, in-flight rows would be skipped forever by step 1's
  filter and `pendingCount` would never decrement to zero.
- Cap: 10,000 entries. Beyond that, `publishIntent` rejects; the store
  reverts the optimistic mutation and the UI shows an error banner.
  Same path for IDB quota errors and "IDB unavailable" (Firefox private
  mode, locked-down browsers). The broker remains the source of truth —
  a page reload reconciles from retained state.

### Queue lifecycle across page reloads

The IDB queue is **durable across reloads**. It's only cleared by:

- The user invoking **"Clear pending queue"** on the connection form
  (calls `queue.clear()`; credentials and `lastGroup` untouched).
- The user invoking **"Disconnect / forget"** (which also calls
  `queue.clear()`, plus wipes `localStorage`).
- Browser site-data clear.
- Successful PUBACK callbacks during flush (per-record deletion).

On boot, the app reads the queue from IDB before mounting the UI, so
`pendingCount` is correct on first paint — the badge shows accumulated
work from previous sessions immediately. Flush is then driven by mqtt.js's
`connect` event, which fires on every successful (re)connect, including
the first one of a fresh session.

| Reload scenario             | What happens                                           |
|-----------------------------|--------------------------------------------------------|
| Reload while online         | Queue persists → boot reads it → `connect` fires → flush drains. Pending → 0 within seconds. |
| Reload while offline        | Queue persists → boot reads it → badge shows pending count. Flush runs whenever the connection lands. |
| Reload mid-flush            | In-flight publish that hadn't received PUBACK still has its IDB record. Next flush re-publishes; broker overwrites the same retained value. Idempotent. |
| User hits "Clear pending queue" | Queue cleared; credentials kept. Unflushed edits are lost; broker retained state stays authoritative. |
| User hits "Disconnect / forget" | Queue cleared, `localStorage` wiped. Connection form re-shown on next load. |

### Caveats

- Multiple tabs of the same origin share IndexedDB and may both enqueue
  and flush intents. Duplicate publishes are absorbed by retained
  semantics (the broker keeps the latest).
- The user must **open the tab** for the queue to drain. We're not shipping
  a service worker in v1, so the queue doesn't sync in the background.
- Tombstones are represented as `payload: null` in IDB. At flush time
  the queue emits a zero-byte buffer (`new Uint8Array(0)`) to `mqtt.publish`,
  which the broker interprets as a delete of the retained value.
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
  (computed per-card — e.g. `Good · 1d` for a new card, `Good · 6d` for
  the second rep) so the user can decide without re-reading the algorithm.
- **No hover-only affordances.** Anything discoverable on hover must also be
  reachable by tap. Tooltips become tap-to-reveal popovers.
- **No swipe gestures.** They conflict with browser back-navigation on
  iOS Safari. Tap is the only interaction.

### Edit mode on mobile

- Word list is a vertical scroll of cards, each showing `text` / `translation`
  with a tap target for the whole row.
- "Add word" is a sticky floating action button (bottom-right, above the nav bar).
- Editing opens a full-screen modal sheet — small screens don't have room
  for inline editing without losing context.
- The form uses native `<input>` and `<textarea>` (no custom rich editors).
  `inputmode` and `autocapitalize` attributes set per field; specifically
  `autocapitalize="off"` on the source-language field if it's known not to need it.

### Performance budget

Mobile data + older devices, so:

- Target **< 100 KB** total transfer (gzipped) for the initial load.
  `mqtt.js` is the largest dependency (~30–60 KB gzipped depending on
  tree-shaking); Svelte runtime + `idb` add ~15 KB more. The target is
  tight but reachable with treeshaking and a lean app surface.
- No web fonts in v1 — system font stack (`-apple-system, Segoe UI, Roboto, …`).
- No animations that block the main thread for more than 16 ms.

### Accessibility

- Color contrast meets WCAG AA against both light and dark backgrounds.
- Respect `prefers-color-scheme` for an automatic dark theme; allow override
  in settings later.
- Respect `prefers-reduced-motion` and skip the reveal animation when set.
- Every interactive element has an accessible name.

## Dev workflow

```bash
npm install
npm run dev         # vite dev server, default http://localhost:5173
npm run test        # vitest
npm run check       # svelte-check + tsc --noEmit
npm run lint        # biome check
npm run build       # produces dist/
npm run preview     # serve dist/ at http://localhost:4173/mwords/
```

Note the `/mwords/` sub-path on `npm run preview` — Vite respects
`base: '/mwords/'` (set to match the GitHub Pages URL), so the app is
not served at root. `npm run dev` is unaffected (root serves fine in
dev).

For local MQTT during development, the simplest option is a public test
broker over WSS (e.g., `wss://test.mosquitto.org:8081`) or a local Mosquitto
configured with a WebSocket listener. Note: **the browser can only speak MQTT
over WebSocket** — TCP-only brokers won't work.

## Deployment (GitHub Pages)

- `vite.config.ts` sets `base: '/mwords/'` (matching the repo name).
- **Pages is deployed via Actions.** `actions/deploy-pages` uploads the
  build artifact directly.
- **Master is decoupled from deploys.** The workflow is triggered by
  pushes to a dedicated **`release`** branch (not by pushes to `master`),
  plus a `workflow_dispatch` for manual UI triggers. Day-to-day commits
  on `master` don't rebuild the site. To ship:

  ```bash
  git push origin master:release   # fast-forward release to master
  ```

  `release`'s HEAD doubles as a "what's live" pointer; `git log
  master..release` shows undeployed commits.
- Workflow (`.github/workflows/deploy.yml`) outline:

  ```yaml
  on:
    push:
      branches: [release]
    workflow_dispatch: {}

  permissions:
    contents: read
    pages: write
    id-token: write

  concurrency:
    group: pages
    cancel-in-progress: false   # GitHub's recommendation for Pages —
                                # let an in-flight deploy complete before
                                # the next starts; cancelling can leave
                                # Pages in a half-deployed state.

  jobs:
    deploy:
      environment:
        name: github-pages
        url: ${{ steps.deployment.outputs.page_url }}
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v6
        - uses: actions/setup-node@v6
          with: { node-version: 24, cache: npm }
        - run: npm ci
        - run: npm run build
        - uses: actions/configure-pages@v6
        - uses: actions/upload-pages-artifact@v5
          with: { path: dist }
        - id: deployment
          uses: actions/deploy-pages@v5
  ```

  One-time repo setup: **Settings → Pages → Build and deployment →
  Source: GitHub Actions**. Done.

## Out of scope for v1

- Multi-user / shared decks (single user assumed; broker ACLs handle isolation).
- Conflict resolution beyond "last write wins".
- Importing/exporting Anki `.apkg` files.
- Audio, images, rich text on cards.
- A service worker / installable PWA.
- Analytics, telemetry.
