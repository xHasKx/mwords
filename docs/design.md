# mwords — Design

A browser-only Anki-like flashcard app for language learning. All persistent state
lives in retained topics on an MQTT broker; the only thing in `localStorage` is the
broker connection info.

## Goals

- **Frontend-only.** Runs on `localhost` during dev and on GitHub Pages in production.
  No backend service of our own — the MQTT broker plays the role of the data store.
- **Two-level organisation: groups and decks.** A **group** is the
  top-level container — a *language* or *project* ("German", "Spanish",
  "Chemistry"). A **deck** is a leaf container of words inside a group
  ("A1 Verbs", "Food", "Lesson 3"). One broker prefix can host many
  groups, each containing many decks. Groups and decks are both
  discovered from the broker on connect; the user picks a group, then
  a deck (or "all decks" for whole-group review) before reviewing /
  editing.
- **Two modes.**
  - **Review** — show a word, hide its translation, let the user grade
    recall (`Again` / `Hard` / `Good` / `Easy`). Review scope is
    selectable: just the active deck, a subset of decks, or every deck
    in the active group.
  - **Edit** — list, add, edit, and delete words. Always scoped to one
    deck at a time (broad review scopes silently narrow to the active
    deck on entering Edit).
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

## Build order (first slice → hardening)

This document specifies the v1 end state. To avoid reading it as one
big-bang, here's a suggested build order. Each slice runs end-to-end
before the next is started.

1. **First slice — happy path online, single tab.** Connect form,
   credentials in `localStorage`, mqtt.js + WSS, phase-1 + phase-2
   subscribes (no debounce, no LWW gate). Group picker (no rename, no
   offline create). Review + Edit views. `publishIntent` calls
   `mqtt.publish` directly (no IDB queue, no dedupe). SM-2 picker
   only. Renders a working app against `wss://test.mosquitto.org:8081`
   or similar.
2. **PublishQueue with IDB.** Add `lib/mqtt/queue.ts` (dedupe by
   topic, fire `mqtt.publish` from `flush()`). Optimistic store
   updates that revert on `publishIntent` rejection. `pendingCount`
   badge. No reconnect backoff yet — let mqtt.js default-retry.
3. **Reconnect + LWW gate.** Exponential backoff w/ jitter and 30 s
   cap. Timestamp UP on publish; LWW comparison on incoming.
   `drainAll()`-before-SUBSCRIBE on `connect`. SUBACK + 500 ms
   debounce. Group-switch sequence (step 10) with spinner overlay
   and UNSUBACK wait. Weighted + Serial pickers; Settings UI.
4. **Edge-case hardening.** Tombstone watermark. Boot-time stale
   `publishedAt` clear (30 s threshold). PUBACK idempotency for
   multi-tab. Validator (zero-byte short-circuit, type guards, range
   checks). Offline group creation. Connection form's "Clear pending
   queue" + "Disconnect/forget."
5. **Polish.** GitHub Pages deploy via `release` branch. Performance
   budget audit. Accessibility pass. Tests (`sm2`, `weighted`,
   `serial`, `topics`, `queue`).

Slices 1–2 give a usable single-device app. Slice 3 makes it
multi-device-safe. Slice 4 closes the rare races. Don't try to land
4 before 1–3 are running.

### v2 build order — Group/Deck split

The v1 build above describes a single-level group model. v2 introduces
a two-level group/deck hierarchy (see [data-model.md](./data-model.md)).
**No migration — v2 ignores anything not at the new topic shape.** Use
a fresh prefix (e.g. `mwords-v2-test`) during development so v1 and v2
retained state don't share a namespace; the user re-imports content
from scratch via Export / Import once v2 is live.

0. **Docs.** Update `data-model.md` and `design.md` to describe the
   new end state — schemas, topic layout, lifecycle, deck picker,
   review scope, Intent additions, localStorage extensions. (This
   slice.) `srs.md` needs no change — the schedulers are
   deck-agnostic and operate on whatever `Word[]` the store hands
   them.
1. **Types, topic builders, validator.** Add `Deck` to
   `lib/types.ts`; rewrite `lib/mqtt/topics.ts` to build / parse the
   new five-shape topic set; add `isDeck` and update the topic-id
   cross-check. Tests: `topics.test.ts` cases for every shape and
   for the legacy-shape rejection.
2. **Stores + whole-group subscribe.** Replace single-group
   subscribe with the three-filter phase-2 subscribe. Reshape
   words / srs stores to `Map<deckId, Map<id, …>>`. Add a `decks`
   store; add `activeGroupId`, `activeDeckId`, and `reviewScope`
   runes (the first replaces the implicit "whatever `lastGroup`
   resolves to" used in v1). Picker wiring derives `Word[]` from
   scope before calling `pickNext`.
3. **Deck picker view + nav-bar copy.** New `DeckPickerView` with
   "All decks" row, per-deck rename/delete, create-new, multi-select
   toggle, and the up-arrow chain. Nav bar has one switch button —
   "Switch deck" — and a Group › Deck breadcrumb; no separate
   "Switch group" button (the deck picker's up-arrow reaches the
   group picker).
4. **Review scope picker in Review view.** Inline three-option
   control + multi-select sheet. Persistence to `lastReviewScope`.
5. **Rename/delete deck publishes.** Mirror group rename/delete via
   the PublishQueue, including the `<P>/g/<G>/d/<D>/#` subtree
   tombstone.
6. **Import/export v2.** New JSON shape; reject `version: 1`; deck
   merge logic.

Each slice runs end-to-end before the next is started, same as v1.

## Stack

| Concern              | Choice                           | Why                                                                 |
|----------------------|----------------------------------|---------------------------------------------------------------------|
| Language             | TypeScript (strict)              | Type-safe MQTT payloads + SRS state.                                |
| UI framework         | **Svelte 5** (runes)             | Tiny runtime, single-file components, low ceremony for a 2-mode app.|
| Build / dev server   | **Vite**                         | First-class TS + Svelte support, instant HMR, easy GH Pages output. |
| MQTT client          | **mqtt.js** (`mqtt` on npm)      | De-facto standard, supports WSS in the browser, auto-reconnect.     |
| Offline queue store  | **idb** (`idb` on npm)           | ~2 KB Promise wrapper over IndexedDB; cursors for in-order flush.   |
| Routing              | Hash-based, hand-rolled          | Handful of views (GroupPicker / Review / Edit / Settings). No router lib needed. |
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
│  $state-backed: connection, groups, words, srsState, settings  │
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
│   │   │   ├── decks.svelte.ts       # decks for active group + active deck + reviewScope
│   │   │   ├── words.svelte.ts       # Map<deckId, Map<id, Word>>, CRUD via MQTT
│   │   │   ├── srs.svelte.ts         # Map<deckId, Map<id, SrsState>>
│   │   │   ├── settings.svelte.ts    # Settings record (global)
│   │   │   └── queue.svelte.ts       # $state mirror of queue.pendingCount
│   │   │
│   │   └── types.ts                # shared domain types (Group, Deck, Word, ReviewScope, Settings)
│   │
│   ├── components/
│   │   ├── ReviewCard.svelte
│   │   ├── GradeButtons.svelte
│   │   ├── ReviewScopePicker.svelte  # inline 3-option scope selector for Review
│   │   ├── WordList.svelte
│   │   ├── WordEditor.svelte
│   │   ├── ConnectionForm.svelte
│   │   ├── ConnectionBadge.svelte  # tiny "connected/disconnected" indicator
│   │   ├── GroupListItem.svelte
│   │   ├── DeckListItem.svelte
│   │   ├── SettingsPanel.svelte
│   │   └── NavBar.svelte
│   │
│   └── views/
│       ├── GroupPickerView.svelte
│       ├── DeckPickerView.svelte
│       ├── ReviewView.svelte
│       ├── EditView.svelte
│       └── SettingsView.svelte
│
├── tests/
│   ├── sm2.test.ts
│   ├── weighted.test.ts
│   ├── serial.test.ts
│   ├── topics.test.ts
│   ├── queue.test.ts
│   └── history.test.ts
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
2. **Read credentials** from `localStorage` (`mwords:connection`). Render
   `ConnectionForm` on boot, pre-filling fields from the stored blob
   when present. The default behaviour is **no auto-connect** — the user
   clicks "Save & connect" to proceed, so reloading the page is a chance
   to switch brokers or fix a bad URL without firing credentials the
   user wanted to edit. The form has an **Autoconnect** checkbox that
   opts into the slice-1 behaviour: if the stored blob has
   `autoconnect: true`, boot skips the form and calls `connect()`
   directly (the form may flash visible for the connecting tick before
   the view transitions). Settings → Disconnect resets the flag to
   false; Disconnect & forget wipes the whole entry.
3. **Connect** to the broker via WSS using `mqtt.js`, configured with
   `resubscribe: false` (our wrapper manages subscriptions explicitly;
   see step 9 for the reconnect path), `reconnectPeriod: 1000` (the
   initial value the backoff strategy starts from — see "Reconnect
   strategy" below), and `keepalive: 30` (half the mqtt.js default of
   60 s so a phantom-offline state — DevTools' "offline" toggle, a
   stalled mobile network — is detected via PINGREQ timeout within
   ~30–45 s instead of ~60–90 s). A small connection
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
   reconnect, step 9's re-subscribe). This guarantees the broker holds
   our latest values by the time retained replay starts, so retained
   messages we receive on our own subscriptions match what we just
   published. The LWW gate (step 9) is still applied for incoming
   messages, but its real job is to defend against *other devices'*
   publishes that may arrive with stale `timestamp`s during steady-state
   operation — not against our own pre-flush state.
4. **Discover groups and load global settings.** In a single SUBSCRIBE,
   register `<P>/g/+` (single-level wildcard under the groups namespace)
   and `<P>/settings`. Retained `Group` payloads stream into the groups
   store keyed by id (the topic suffix `<G>`); the retained `Settings`
   payload streams into the settings store (or defaults are used if absent).
   Wait for **SUBACK + the 500 ms debounce** (same rule as step 6) before
   moving on, so the group picker in step 5 sees a complete groups list.
   Both subscriptions stay active for the lifetime of the connection so
   changes from other devices — new groups, renames, settings changes —
   propagate live.
5. **Select a group and deck.** If `lastGroup` resolves to a discovered
   group, auto-select it. Otherwise render `GroupPickerView` (and if
   `lastGroup` didn't resolve, drop it from the `mwords:connection`
   blob). The user picks an existing group or creates a new one; either
   way the app runs the **group-switch sequence** (step 10).

   Once the group is active and synced, **pick a deck**: if `lastDeck`
   resolves to a deck inside the active group, restore it as the
   active deck (and restore `lastReviewScope`, filtering any stale
   deck ids). Otherwise render `DeckPickerView` — see "Deck picker"
   below. The user picks a deck (or "All decks" for whole-group
   review, or a multi-deck selection); the deck picker is also the
   place where new decks are created.

   For an empty broker, the group picker opens in "create" mode by
   default; once the user creates a group, the deck picker opens
   inside it in "create" mode too. A single "switch deck" affordance
   in the nav bar returns to the deck picker at any time; the deck
   picker itself has an up-arrow that reaches the group picker.
6. **Subscribe to the active group.** Subscribe in one SUBSCRIBE to:
   `<P>/g/<G>/d/+`, `<P>/g/<G>/d/+/words/+`, and
   `<P>/g/<G>/d/+/srs/+`. Retained messages flood in and populate the
   decks / words / srs stores, gated by the timestamp-LWW check
   described in step 9. The store synthesizes the parent-deck
   relationship from the parsed topic — `Word` and `SrsState` payloads
   don't carry `deckId`. (Settings are already loaded from phase 1 and
   are global, so they're not re-subscribed here.)

   Loading every deck's words on group open is a deliberate trade —
   see [`data-model.md`](./data-model.md) → "Subscription pattern (two
   phases)". Multi-deck and whole-group Review modes become in-memory
   filter changes; per-deck switching within a group is instant (no
   SUBSCRIBE / UNSUBSCRIBE round-trip).

   The app transitions to **"synced"** only when **both** of the
   following are true:
   - **SUBACK received** for the three-filter SUBSCRIBE. This is the broker's
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
   `mwords:connection` blob in `localStorage` once subscription
   succeeds; `lastDeck` is updated separately when the user picks a
   deck in step 5's deck-picker phase.
7. **Default view** is `Review` if there's at least one due word in the
   active review scope, else `Edit`. This step only runs once a deck is
   active; the no-active-deck case has already been routed to the deck
   picker by step 5.
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
      grade isn't worth gating the next card on. Fire-and-forget call
      sites still attach a `.catch(err => log(err))` so a rare IDB
      failure surfaces in logs rather than becoming an unhandled
      promise rejection. Errors are counted but never block the UI.

   The actual broker round-trip is *not* part of this path. PUBACK
   happens later and only affects when the queue removes the record
   from IDB; the UI doesn't care.
9. **On reconnect**, the wrapper repeats step 3's sequence: `await
   queue.drainAll()`, then re-issue the active subscriptions
   (`resubscribe: false`, so the wrapper is the source of subscription
   state). Retained snapshots re-flood the stores. **Each incoming
   message — on reconnect *or* during steady state — passes through
   the LWW gate below.**

   The LWW timestamp is `payload.updated` (epoch seconds), mirrored
   into the MQTT 5 `timestamp` User Property of every publish. The
   gate compares the incoming UP against the local record's
   `updated`:

   - **No usable UP** (property absent, empty string, or
     `Number(value)` not finite & positive — note `Number('') === 0`,
     not `NaN`, so test the raw string for emptiness first): accept
     unconditionally.
   - **UP < local `updated`**: discard. Our local state is newer.
   - **UP ≥ local `updated`**:
     - Content publish → overwrite the store entry with the new
       payload (its `updated` becomes the new local timestamp);
       drop any tombstone-watermark entry for this id.
     - Tombstone (zero-byte short-circuit) → delete the local record
       and set `watermark[id] = UP`.
   - **No local record for this id**: consult the tombstone watermark
     (see below). If `watermark[id]` exists and UP ≤ it, discard;
     otherwise accept as above.

   After the gate finishes, the PublishQueue drains any pending
   intents — edits made while disconnected then beat the broker's
   stale retained values on the next round-trip.

   **Tombstone watermark.** A per-store `Map<id, number>` held in
   memory only. Populated whenever a tombstone is accepted (and
   seeded synchronously by optimistic local deletes, so the resurrect
   defense is armed before the broker echoes our publish back). It
   exists solely to stop a stale content publish from a peer's
   queued-while-offline backlog from resurrecting a tombstoned id
   within the same session. It is **not** persisted: a stale publish
   arriving after a fresh page load can still resurrect the record,
   which we accept under the LWW trade-off documented in "No
   history; LWW conflict resolution."
10. **Group-switch sequence.** A blocking transition (unlike initial
    boot in step 6, where retained replay can stream in while the user
    interacts). Applies to both "pick existing" and "create new" from
    the group picker, and to mid-session group switches (reached by
    tapping the up-arrow inside the deck picker). For new groups,
    publish the `Group` marker first; the rest is identical.
    1. If a previous group is active, overlay a full-screen
       "Switching to *{groupName}*…" spinner on the current view
       (Review / Edit / a picker) and ignore input on it. Skipped at
       first boot — there's no prior view to block.
    2. If a previous group is active, unsubscribe its three filters
       (`<P>/g/<G>/d/+`, `<P>/g/<G>/d/+/words/+`,
       `<P>/g/<G>/d/+/srs/+`), **await UNSUBACK** (so the broker
       stops delivering matching messages before we touch the
       stores), then clear the decks / words / srs stores and reset
       `activeDeckId = null` and `reviewScope = { kind: 'active-deck' }`.
    3. Subscribe the new group's three filters. Wait for SUBACK + the
       500 ms debounce (same rule as step 6). Set `activeGroupId`
       to the new `<G>` once SUBACK arrives.
    4. Update `lastGroup` in `localStorage` and clear `lastDeck` and
       `lastReviewScope` in the same write (they belonged to the
       previous group). Dismiss the spinner. Render the deck picker
       for the new group (no `lastDeck` to restore from at this
       point).

    The discovery + global-settings subscriptions are untouched.

    **Deck-switch is not a sequence.** Picking a different deck within
    the active group is purely in-memory: set `activeDeckId`,
    `reviewScope = { kind: 'active-deck' }`, persist `lastDeck` /
    `lastReviewScope`, render the target view. No SUBSCRIBE /
    UNSUBSCRIBE, no spinner. Same is true for the multi-deck and
    whole-group review scopes.

    **Offline variant.** When `create new` is submitted while
    disconnected, steps 2–3 are deferred: queue the `Group` marker,
    insert the new group into the in-memory groups store with empty
    decks / words / srs maps, persist `lastGroup` (and clear
    `lastDeck` / `lastReviewScope`), render the deck picker
    immediately. On the next `connect`, `drainAll()` flushes the
    marker, then the deferred subscribe + debounce runs. Creating the
    first deck inside that group is an analogous offline-tolerant
    publish — the `Deck` marker is queued and the deck appears
    instantly in the in-memory store.

## Connection form

The form is the app's landing screen on every boot (see lifecycle step
2) and is also re-shown by **Settings → Disconnect** mid-session. When
stored credentials exist, every field is pre-filled from
`localStorage`; the user can edit any of them before submitting.

- Three fields: WebSocket URL (e.g., `wss://broker.example.com:8884/mqtt`),
  username, password.
- Optional fourth: **base prefix** (default `mwords`). Validated against
  the rules in [data-model.md](./data-model.md) → "LocalStorage"
  (`StoredConnection.prefix`). This namespaces the app on a shared broker.
  The group is **not** entered here — it's chosen at runtime in the next
  step.
- **Autoconnect** checkbox. Pre-filled from the stored
  `autoconnect` flag (defaults to off when absent). Every Save & connect
  submission writes the current checkbox value, so toggling it just
  takes effect on the next reload.
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

### Settings → Disconnect controls

The connection form's exit paths have mirrors inside Settings, so the
user can drop the broker connection mid-session without losing their
place:

- **"Disconnect"** — tears down the MQTT client and returns to the
  connection form. Credentials, prefix, and `lastGroup` survive in
  `localStorage`; the **`autoconnect` flag is cleared** so the next
  page reload waits for the user to confirm. The user is expected to
  either edit a field and reconnect, or just resubmit (re-ticking
  Autoconnect if desired). The pending queue is left alone (it drains
  on the next connect).
- **"Disconnect & forget"** — also removes the `mwords:connection` key
  from `localStorage` (credentials, prefix, and `lastGroup` go with
  it) and clears the queue. Strict superset of "Disconnect" + "Clear
  pending queue." The connection form then opens with empty fields.

### Settings → Share connection link

A "Copy share link" affordance in the same Connection card produces a
URL the user can paste to another device to bootstrap the same broker
binding without re-typing.

- **Payload.** The four connection-form fields — `url`, `username`,
  `password`, `prefix` — JSON-stringified, then URL-safe-base64
  encoded (`+→-`, `/→_`, stripped `=`). Per-device state (`lastGroup`,
  `autoconnect`) is intentionally **not** included. Implemented in
  `lib/share.ts` (`encodeShare` / `decodeShare`).
- **URL shape.** `<origin><pathname>#share=<base64>`. The payload sits
  in the **hash fragment**, which the browser never sends to the
  server, so the value never lands in access logs or referrers.
- **Not encryption.** Base64 is obfuscation — anyone with the URL has
  the credentials in plaintext. The UI says so. The point is to keep
  creds non-readable from an address bar (shoulder-surfing,
  screen-shares) without taking a key-management dependency.
- **Receiver behavior.** On `app.init()`, if `location.hash` starts
  with `#share=`, decode → set `shareImport` on the store → scrub the
  hash via `history.replaceState`. Autoconnect is **suppressed** for
  this session even when `storedConn.autoconnect` is true. The connect
  form pre-fills from `shareImport` (with `autoconnect` reset to
  `false` — the receiver opts in deliberately) and shows a banner
  flagging that the values came from a share link. Existing stored
  creds are untouched until the user submits.
- **Failure modes.** Malformed payloads — bad base64, non-JSON,
  missing or wrong-typed fields — are silently dropped (the hash is
  still scrubbed) and the form falls back to the stored connection.

## Group picker

- Each row shows the group name only — no counts, due-today badges, or
  other stats. Order in v1 is "as discovered" (insertion order into the
  groups store from the retained replay); explicit sorting can be added
  later. The picker stays fast because we don't pre-subscribe to every
  group's decks and words just to render the list.
- **Each row has an inline "edit" affordance** (pencil icon, tap-to-rename).
  Tapping it switches the row into rename mode with the current name in a
  text input; submitting publishes a new `Group` to the same `<P>/g/<G>`
  topic with the updated `name`, the unchanged `id` and `created`, and a
  fresh `updated` (`Date.now() / 1000`). Cancel just reverts the UI.
- "Create new group" inline input at the bottom. On submit, allocates
  a fresh id (`Date.now().toString()`), publishes the `Group` marker
  via the PublishQueue, then runs the group-switch sequence (step 10).
- Both inputs validate the name against the rules in
  [data-model.md](./data-model.md) → "Group and deck names (display only)".
- **Each row also has an inline "delete" affordance** (✖, danger-coloured)
  with a `confirm()` dialog. See "Group deletion" below for the publish
  shape and broker caveats.
- Reachable from the **deck picker's up-arrow** (the nav bar has no
  direct "switch group" entry — its "Switch deck" button reaches the
  deck picker first). Group switching pays for an UNSUBSCRIBE +
  SUBSCRIBE round-trip and a brief "Switching to *…*" overlay; see
  step 10.

### Group deletion

Tap the ✖ on a group row, confirm, and the picker publishes **two
tombstones** (both empty payload, `retain: true, qos: 1`) via the
PublishQueue:

1. `<P>/g/<G>/#` — a retained-empty publish to the wildcard-subtree
   topic. **This is a broker-specific extension.** flespi treats it
   as "clear all retained messages under this prefix" — so every
   `d/<D>` marker plus every nested `words/<id>` and `srs/<id>`
   retained message under the group disappears in one shot. The MQTT
   5 spec **forbids** `#` (and `+`) in a PUBLISH topic name
   (§4.7.1), so on a strictly-conforming broker the PUBLISH is
   rejected with a `Topic Name invalid` reason code (0x90) and the
   subtree is left intact. Accepted for v1 on the assumption the
   user is on flespi; documented for porting.
2. `<P>/g/<G>` — the group marker itself, so peers drop it from their
   picker via the usual tombstone path.

Local cleanup happens optimistically before the publish (the
tombstones live in the durable queue, so they survive a flaky
connection). If the deleted group was active, mwords also
unsubscribes the phase-2 filters, clears the decks / words / srs
maps, clears `lastGroup`, `lastDeck`, `lastReviewScope`, and
`pickerReturn`, and sets `activeGroupId = activeDeckId = null`.
There is **no tombstone watermark for groups or decks** in v1 — a
peer's stale `Group` / `Deck` republish for a deleted id could in
principle resurrect it. Accepted on the same "users rarely delete
groups / decks" basis as the broker caveat above.

## Deck picker

The deck picker is the screen reached after a group is active — at
boot (when no `lastDeck` resolves) and at any time via the nav bar's
"Switch deck" button. It is **always scoped to one group** (the active
one).

- **Header** shows the active group's name and an **up-arrow** on the
  left. Tapping the arrow opens the group picker via `replaceIntent`
  (so back from the new group's deck picker returns to whichever view
  led into the switch-deck flow originally, not through an
  intermediate group picker entry).
- **"All decks (review)" row at the top** — a fixed first row. Tapping
  it sets `reviewScope = { kind: 'group' }` (does **not** change
  `activeDeckId`) and pushes the Review view. The Edit tab is still
  usable while in this scope, but tapping it silently narrows scope
  back to `{ kind: 'active-deck' }`; if `activeDeckId` is null, the
  Edit tab pushes the deck picker first with `pickerReturn = 'edit'`.
- **One row per deck**. Each row shows the deck name and a word count.
  Order is "as discovered" (same convention as the group picker). Tap
  to set `activeDeckId = <D>` and `reviewScope = { kind: 'active-deck' }`,
  then push the target view (Review by default, or whatever
  `pickerReturn` was set to).
- **Pencil + ✖ per row**, mirroring the group picker affordances.
  Rename publishes a new `Deck` to the same `<P>/g/<G>/d/<D>` topic.
  Delete is gated by `confirm()` and runs the deck-deletion publish
  (see "Deck deletion" below).
- **"Create new deck" inline input** at the bottom. Validates the name
  against [data-model.md](./data-model.md) → "Group and deck names
  (display only)". On submit, allocates a fresh
  `Date.now().toString()` id, publishes the `Deck` marker via the
  PublishQueue, sets it as the active deck, and pushes the target
  view. Offline-tolerant — see step 10's offline variant.
- **"Select multiple" toggle** in the header. Flips rows into
  checkbox mode and shows a sticky bottom "Review selected (N)"
  button. Tapping that button sets `reviewScope = { kind: 'decks',
  deckIds: <selected> }` and pushes Review. Multi-deck selection does
  **not** change `activeDeckId` (just like the "All decks" row).
- Empty group: the picker still renders with the header, the "All
  decks" row (which when empty just shows a "No words yet" Review
  view), and the "Create new deck" input.

## Review scope

`reviewScope` is the projection that controls which words the Review
picker sees. The store derives a flat `Word[]` based on it and hands
that to the picker dispatcher (`pickNext`):

```ts
type ReviewScope =
  | { kind: 'active-deck' }                       // words in activeDeckId
  | { kind: 'decks'; deckIds: string[] }          // union over deckIds
  | { kind: 'group' };                            // union over active group
```

- Default is `{ kind: 'active-deck' }`.
- Set by the deck picker entries (single row → `active-deck`,
  multi-select → `decks`, "All decks" row → `group`).
- Set by the **Review view's inline scope selector** — a compact
  three-option control at the top of the Review view: *Just this deck
  / Selected decks / All decks*. *Selected decks* opens a mini
  multi-select sheet listing the active group's decks; the previously
  selected `deckIds`, if any, are pre-checked.
- Persisted to `localStorage` (`lastReviewScope`) alongside `lastDeck`.
  Multi-deck `deckIds` are filtered against the active group's decks
  on restore; an empty filtered list falls back to `active-deck`.
- **Edit always operates on the active deck.** If `reviewScope` is
  `decks` or `group` and the user enters Edit, scope silently narrows
  to `{ kind: 'active-deck' }` and the persistence is rewritten
  accordingly. The status line in Edit shows "Editing: *{deckName}*"
  to make the narrowing explicit.

### Deck deletion

Tap the ✖ on a deck row, confirm, and the picker publishes **two
tombstones** via the PublishQueue:

1. `<P>/g/<G>/d/<D>/#` — wildcard-subtree retained-empty publish.
   Same flespi-extension caveat as group deletion; on strict brokers,
   the words/srs under the deck become orphans.
2. `<P>/g/<G>/d/<D>` — the deck marker itself.

Local cleanup is optimistic. If the deleted deck was the
`activeDeckId`, it's cleared (set to null); if it appeared in a
`reviewScope.deckIds` list, it's pruned from the list (and the scope
falls back to `active-deck` if the list goes empty). `lastDeck` is
cleared from `localStorage` if it pointed at this deck. The user
lands back in the deck picker for the active group.

There is no tombstone watermark for decks (same reasoning as groups —
deletion is rare; acceptable LWW trade-off).

## Export and import

A small "Import / Export" card on the group picker lets the user move
their **content** between mwords instances. Scope is intentionally
narrow:

- **Content only.** Group names, deck names, and word text/translation
  pairs only. SRS state, ids, timestamps, settings, and per-device
  prefs (`lastGroup`, `lastDeck`, `lastReviewScope`, `autoconnect`)
  are deliberately **not** in the file. This is a way to share or
  seed *what to learn*, not a full backup and restore. Re-importing
  a file into the same instance merges groups by name and decks by
  name within each group (see "Import" below) but duplicates every
  word inside them with reset SRS state, because v2 doesn't dedup
  words by `text` / `translation`.
- **Format.** A single JSON file:
  ```json
  {
    "version": 2,
    "groups": [
      {
        "name": "German",
        "decks": [
          {
            "name": "A1 Verbs",
            "words": [
              { "text": "Hallo", "translation": "Hello" }
            ]
          }
        ]
      }
    ]
  }
  ```
  Minified (`JSON.stringify(value)` — no indentation). The `version`
  field gates the schema. **`version: 1` files are rejected** —
  the v1 schema had no deck level, so an automatic upgrade would
  have to invent deck names; we refuse and tell the user to
  re-export from the source instance.

### Export

- Button: "Export to file" in the group picker's Import/Export card.
- Default filename: `mwords-export-YYYY-MM-DD-HH-MM-SS.json`
  (local time). Including time lets multiple same-day exports
  coexist on disk without a save-dialog overwrite prompt.
- **Two gates, two purposes.**
  - **UI gate (status flag).** The Export button is visibly
    disabled while `app.connection !== 'connected'` (with a "Connect
    to export" tooltip). Stops users from initiating an export that
    can't run, instead of letting them click and watch it fail.
  - **Execution gate (fresh-client probe).** When the button *is*
    clicked, the export's own throw-away client tries to connect
    against the same `StoredConnection`. If that fails, the export
    surfaces a real connection error — independent of whatever
    `app.connection` currently claims. The status flag can lag a
    truly-broken link (e.g. a phantom-offline state), so the probe
    is the source of truth at action time.
- **Isolated transport.** The export opens a **separate, throw-away
  mqtt.js client** using the same `StoredConnection` (URL,
  credentials, protocol version) as the main client. The live
  client's subscriptions, message handler, and reactive state are
  not touched. Rationale:
  - Live updates to the active group keep flowing through the main
    client during the scan. No "Exporting…" curtain is required to
    pause the rest of the app.
  - No `handleMessage` refactor, no subscription juggling on the
    main client, no risk that a failed scan leaves the live session
    in a half-state.
  - mqtt.js generates a random `clientId` per connection by default,
    so the two simultaneous sessions to the same broker with the
    same credentials don't collide.
- **Mechanism.**
  1. Lazy-import `mqtt` (already split out for the main client, so
     no extra bundle cost on second use) and open a fresh client
     against `storedConn`. Wait for `connect`.
  2. Allocate the capture map:
     `Map<gid, { name?: string; decks: Map<did, { name?: string;
     words: Map<wordId, {text, translation}> }> }>`.
  3. `subscribe('<P>/g/#', { qos: 1 })` — one SUBSCRIBE packet with
     one wildcard filter. No chunking concerns and no broker
     filter-count ceiling to worry about.
  4. The export client's message handler routes by parsed topic:
     - `<P>/g/<G>` (group marker) → validate, set `capture[G].name`
       (or remove the entry on tombstone).
     - `<P>/g/<G>/d/<D>` (deck marker) → validate, set
       `capture[G].decks[D].name` (or remove the deck on tombstone).
     - `<P>/g/<G>/d/<D>/words/<id>` → validate, set
       `capture[G].decks[D].words[id]` (or remove on tombstone).
     - `<P>/g/<G>/d/<D>/srs/<id>` → ignored (export is content-only).
     - Anything else (including legacy `<P>/g/<G>/words/<id>` from
       the old shape) → ignored.
  5. Wait for the same 500 ms post-message debounce mwords already
     trusts for "synced". A local timer in the export module
     resets on every incoming message; 500 ms of silence means the
     retained replay drained.
  6. Snapshot the capture into the export JSON (dropping groups
     whose name was tombstoned away, dropping decks ditto, dropping
     word entries that went tombstone, and dropping any deck with
     zero words — the file is for seeding *content*). Trigger a
     browser download via `Blob` + `URL.createObjectURL` + a
     synthetic `<a download>` click.
  7. `client.end(true)` to close the export client.
- **No "Exporting…" overlay needed**, because the main UI keeps
  working. A small inline status next to the button ("Exporting…"
  → "Saved as mwords-export-…json") is enough.
- **Failure modes.** Bad credentials / unreachable broker → the
  fresh client's `connect` event never fires; surface a clean error
  with a hint to check the connection. Mid-scan disconnect → same:
  the timer can't drain, so we time out after, say, 10 s of total
  scan time and surface "Export interrupted, try again."

### Import

- Button: "Import from file" in the same card, behind a hidden
  `<input type="file" accept=".json">` that the button triggers
  programmatically.
- The file is parsed and validated against the v2 schema (object
  with `version: 2`, `groups: array`, each group with a non-empty
  trimmed `name` and a `decks: array`, each deck with a non-empty
  trimmed `name` and a `words` array of `{text, translation}`
  objects). `version: 1` files are rejected with a clear "Re-export
  from the source instance" error. On any other validation
  failure: no state changes, surface a clear error.
- **Merge by name, two levels.** For each group in the file:
  - If a local group already exists with the same trimmed name,
    reuse it; otherwise create a new one (fresh id, fresh
    timestamps).
  - For each deck inside that group: if a local deck already
    exists with the same trimmed name *within that same group*,
    reuse it; otherwise create a new deck (fresh id, fresh
    timestamps).
  - For each word inside that deck: always create a fresh word
    (new id, new timestamps, default SRS state) under the resolved
    deck. No de-duplication by text/translation in v2.
- All publishes go through the existing PublishQueue, so the import
  is resilient to a flaky connection and idempotent under the same
  retry semantics as normal edits.
- Active subscriptions are unchanged — imported words for the
  active group will land in `app.words` naturally as their publishes
  PUBACK and replay back to us.
- An "Importing…" overlay blocks input while publishes are
  enqueued. The card briefly reports "Imported N groups, M words"
  on completion.
- **Not a transaction.** A failure partway through (queue cap hit,
  user navigates away) leaves whatever was already enqueued in the
  queue; it flushes on the next connect. Documented; acceptable for
  v1.

### Caveats

- **Not a backup.** SRS state is not preserved.
- **Offline export is a no-op.** v1 requires the broker to be
  reachable. An offline-tolerant export would need words for every
  group cached locally, which mwords doesn't do today.
- **Atomicity.** A peer editing a word during the scan may produce a
  before/after mix (some words pre-edit, some post-edit). Bounded by
  the 500 ms debounce; accepted for v1.

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
  const jittered = next * 2 * (0.8 + Math.random() * 0.4);
  next = Math.min(MAX, Math.round(jittered));
  client.options.reconnectPeriod = next;
});
client.on('connect', () => {
  // Reset BOTH — mqtt.js consumes `reconnectPeriod` before the next
  // `reconnect` event fires, so resetting only `next` leaves a stale
  // period in effect for the first post-reconnect wait.
  next = MIN;
  client.options.reconnectPeriod = MIN;
});
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
number, with a **secondary index on `topic`** (used by `publishIntent`'s
dedupe-replace lookup so the operation is a single index probe rather
than a `getAll`+filter scan). Record shape:

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
drainAll():                    Promise<void>;     // captures the set of `seq`
                                                  // values currently in IDB at
                                                  // call time, and resolves when
                                                  // every one of *those* rows
                                                  // has been PUBACK'd and removed.
                                                  // New intents enqueued after
                                                  // the call are flushed normally
                                                  // but do NOT extend the wait —
                                                  // otherwise a user editing
                                                  // during the connect-handler's
                                                  // pre-subscribe window could
                                                  // starve `drainAll()` and block
                                                  // SUBSCRIBE indefinitely. Used
                                                  // by the connect handler before
                                                  // issuing SUBSCRIBE.

pendingCount: number;                             // plain field — count of
                                                  // intents currently in IDB.
                                                  // `lib/mqtt/queue.ts` stays
                                                  // framework-agnostic, so it
                                                  // does NOT use `$state` here.
onChange(cb: () => void): () => void;             // register a callback fired
                                                  // whenever `pendingCount`
                                                  // changes; returns an
                                                  // unsubscribe fn. Used by
                                                  // `lib/stores/queue.svelte.ts`
                                                  // — a thin Svelte shim that
                                                  // mirrors the count into a
                                                  // `$state` rune for the
                                                  // connection badge.
```

Both `publishIntent` and `publishTombstone` resolve **as soon as the intent
has been persisted to IndexedDB** — they do *not* wait for PUBACK. UI
callers `await` them on commit-like actions (Save, Settings change, etc.)
to catch IDB failures (quota / queue cap / unavailable). Non-commit call
sites can fire and forget. The actual MQTT round-trip happens in the
background and never blocks the UI thread.

`pendingCount` is incremented when a new intent is written to IDB (or kept
flat when a dedupe-replace happens — same row, same count) and decremented
when a PUBACK callback deletes a record. `clear()` zeroes it in the same
IDB transaction that wipes the store, so the badge transitions to "no
pending" atomically with the deletion. It's the same number shown in the
connection badge.

**Concurrency rule.** Every mutation of an `intents` row happens
**inside a fresh `readwrite` transaction**: open tx → re-read by
`seq` → decide based on the re-read row (or skip if it's gone) →
write back → commit. Never write a stale snapshot copy from a
prior `getAll()` — a concurrent `publishIntent` may have
dedupe-replaced the row, a sibling PUBACK may have deleted it, or a
parallel `flush()` may have marked it in-flight. This pattern is
shared by every path below; it's the only thing standing between us
and lost updates / double publishes / `pendingCount` drift, and it
removes the need for any top-level single-flight flag.

**Behaviour:**

- `publishIntent` / `publishTombstone`:
  1. **Dedupe** — open the tx, walk the `topic` index for the target
     topic, pick the lowest-`seq` row with `publishedAt` unset, and
     replace it in place (same `seq`, new `payload`/`enqueuedAt`).
     If every row for the topic is in-flight, or there are none,
     append a new row instead. Tombstones and content publishes
     dedupe each other.
  2. Commit the tx; if connected, schedule a flush (microtask
     debounce).
- `flush()` is called on `connect` (via `drainAll()`) and after each
  `publishIntent`:
  1. `store.getAll()` into a local array. Skip rows already marked
     in-flight (`publishedAt` set). `mqtt.publish` is fire-and-forget
     per intent; the per-intent PUBACK callback handles each
     independently. No concurrency cap beyond the 10 k queue cap.
  2. **Mark in-flight.** For each remaining intent, open a tx,
     re-read by `seq`. If the row is missing or already in-flight,
     skip. Otherwise set `publishedAt = Date.now() / 1000`, commit,
     then call `mqtt.publish` with the re-read row's payload (do
     **not** use the step-1 snapshot copy).

     ```ts
     const tx = idb.transaction('intents', 'readwrite');
     const current = await tx.store.get(intent.seq);
     if (!current || current.publishedAt !== undefined) {
       await tx.done; continue;
     }
     current.publishedAt = Date.now() / 1000;
     await tx.store.put(current);
     await tx.done;

     const bytes = current.payload === null
       ? new Uint8Array(0)
       : new TextEncoder().encode(JSON.stringify(current.payload));
     const tsSec = (current.payload !== null
                    && typeof current.payload.updated === 'number')
       ? current.payload.updated
       : Date.now() / 1000;                           // tombstone / no `updated`

     mqtt.publish(current.topic, bytes, {
       qos: 1,
       retain: current.retain,
       properties: { userProperties: { timestamp: tsSec.toString() } },
     });
     ```
  3. **`mqtt.publish` callback** `(err, packet)`. Apply the
     concurrency rule (fresh tx, re-read by `seq`, skip if gone):
     - **Success**: delete by `seq` (idempotent — only decrement
       `pendingCount` when the delete actually removed a row).
       Remove `seq` from any in-flight `drainAll()` snapshot set; if
       the snapshot is now empty, resolve that promise. (`drainAll()`
       resolves on snapshot drain, **not** on `pendingCount === 0`,
       so post-call enqueues can't extend the wait.)
     - **Error** (broker rejected, topic invalid, payload too large,
       …) or **synchronous throw from `mqtt.publish`**: clear
       `publishedAt` and put back. Do **not** delete. The next flush
       retries. On a sync throw, also stop iterating the current
       flush pass.
- On **every** transition into "connected" *and* "reconnecting"
  (mqtt.js's `connect` / `close` events), the wrapper clears
  `publishedAt` on every IDB row in a single bulk-update transaction.
  Doing it on `close`/`offline` is the obvious case — PUBACK never
  arrived. Doing it on `connect` too is a defence against the
  "phantom-connected" state where mqtt.js still thinks the socket is
  open but data isn't flowing (e.g. DevTools' "offline" toggle, which
  blocks traffic without dropping the WebSocket). In that mode a flush
  marks rows in-flight and PUBACK never lands; the next genuine
  `connect` event finds those zombie markers and resets them so the
  re-flush retries. The PUBACK callback already no-ops on a missing
  row, so a duplicate publish from a stale tab races safely.
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

On boot, the app reads the queue from IDB before mounting the UI so
`pendingCount` is correct on first paint. The clear-on-connect
behaviour above also covers force-quits and crashes — the next
successful `connect` resets any leftover `publishedAt` markers.
Flush itself is driven by `connect`.

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

## Back navigation

On mobile, the hardware/gesture back button is the primary "undo this step"
affordance. In v1 the app ignored it entirely — every press unloaded the SPA.
v2 wires the app into `window.history` so back/forward feel native: dismiss
the open modal, leave the deck (or group) picker, walk back through the
tabs the user actually visited, and only exit when there's nothing left
to undo.

No URL routing. The address bar never changes (except the one-shot share-hash
scrub on boot). History entries carry a synthetic `state` payload only; the
pathname is fixed at `/mwords/`. Hash-based deep linking is out of scope —
see "Out of scope for v1".

### Intent as the unit of history

The app's navigable state is reduced to an **intent**:

```ts
type Intent = {
  view: 'connect' | 'picker' | 'deck-picker' | 'review' | 'edit' | 'settings';
  modal?:
    | { kind: 'word-editor'; wordId?: string }    // wordId absent ⇒ new word
    | { kind: 'rename-group'; groupId: string }
    | { kind: 'rename-deck'; deckId: string };
  pickerReturn?: 'review' | 'edit' | 'settings';  // set with view: 'picker'
                                                  // or view: 'deck-picker'
};
```

This is the **only** thing pushed to `history.state` (under a `mwords` key to
namespace against any future use of `history.state`). The store still has its
existing fine-grained runes (`view`, `pickerReturn`, modal-open flags,
`activeDeckId`, `reviewScope`, etc.); the intent is just the projection
that matters for navigation.

`pickerReturn` is the **final** destination after picker chains
finish. From the group picker, picking a group routes through the
deck picker (via `replaceIntent({ view: 'deck-picker', pickerReturn })`)
before reaching `pickerReturn` — the user always picks a deck before
landing in Review / Edit / Settings. From the deck picker, picking a
deck `replaceIntent`s straight to `pickerReturn`.

### Push, replace, and the single mutator

The store grows two methods:

- `pushIntent(next: Intent)` — apply `next` to the store's runes, then
  `history.pushState({ mwords: next }, '')`.
- `replaceIntent(next: Intent)` — apply `next`, then `history.replaceState`.

Every existing affordance that changes view, opens/closes a modal, or enters
the switch-deck (and onward switch-group) flow routes through one of
these — direct mutation of `app.view` / `app.pickerReturn` is removed
from components. Affordances using each:

| Action                                                | Method            |
| ----------------------------------------------------- | ----------------- |
| `init()` seeds the first entry                        | `replaceIntent`   |
| Connect form submit success → group picker (no `lastGroup`) | `pushIntent`      |
| Connect form submit success → deck picker (`lastGroup` resolves, no `lastDeck`) | `pushIntent` |
| Connect form submit success → review (`lastGroup` + `lastDeck` resolve) | `pushIntent` |
| Group-picker row picked → deck picker (keeps `pickerReturn`) | `replaceIntent`   |
| Deck-picker row picked → `pickerReturn` (review/edit/settings) | `replaceIntent` |
| Deck-picker "All decks" picked → review               | `replaceIntent`   |
| Deck-picker "Review selected (N)" → review            | `replaceIntent`   |
| Nav-bar tab tap (review ↔ edit ↔ settings)            | `pushIntent`      |
| Nav-bar "switch deck" → deck picker                   | `pushIntent` (with `pickerReturn`) |
| Deck picker up-arrow → group picker                   | `replaceIntent` (keeps `pickerReturn`) |
| Picker pencil → rename modal (group / deck)           | `pushIntent`      |
| Edit "Add word" / row tap → word-editor modal         | `pushIntent`      |
| Modal Save / Cancel / ✖                               | `history.back()` (see below) |
| Settings → Disconnect → connect form                  | `replaceIntent`   |
| Share-hash scrub                                      | `history.replaceState` (already in place) |

The deck picker's up-arrow uses `replaceIntent` rather than
`pushIntent` so that after the user picks a different group in the
group picker (which also `replaceIntent`s onward to its deck picker),
the back stack reads "originating view → new group's deck picker" —
no intermediate group-picker entry. Back from the new deck picker
lands the user wherever they started the switch-deck flow.

### popstate is the single applier

A single `popstate` listener installed at `init()` reads `event.state?.mwords`
and applies it to the store. Modal close, picker cancel, and tab back all
flow through here:

1. User (or in-app button) triggers `history.back()`.
2. Browser fires `popstate` with the previous entry's intent.
3. Listener diffs the popped intent against the store's current state and
   applies the delta (close modal, switch view, leave picker, etc.).

Closing a modal via its in-modal button calls `history.back()` rather than
mutating the store directly. The popstate listener then does the actual
state change. One source of truth for "modal closed" regardless of whether
the user used the back button or the ✖.

No re-entrancy guard is needed because the store mutations performed by
popstate do **not** call `pushIntent` / `replaceIntent` — they apply state
directly. The only thing that pushes is forward-navigation code paths.

### Boot, autoconnect, and the seed entry

`app.init()` must leave `history.state.mwords` non-null so popstate handlers
can rely on it. Seeding rules:

- Share-hash present (`#share=…`): consume + scrub the hash (already done),
  then `replaceIntent({ view: 'connect' })`. Back exits the SPA.
- Stored creds with `autoconnect: true`: `replaceIntent({ view: 'connect' })`,
  then once `connected` arrives and the group resolves, `pushIntent` to the
  post-connect view. Back from that view returns to the connect form
  (matches the "Should the connect form be poppable? — Yes" decision).
- Stored creds without autoconnect, or no creds: `replaceIntent({ view: 'connect' })`.

The post-connect destination follows a two-step resolution:

- `lastGroup` doesn't resolve → `view: 'picker'` (group picker), no
  `pickerReturn` (the natural landing, not a switch flow).
- `lastGroup` resolves, but `lastDeck` doesn't resolve to a deck
  inside that group → `view: 'deck-picker'`, no `pickerReturn`.
- Both `lastGroup` and `lastDeck` resolve → `view: 'review'` (with
  `lastReviewScope` restored, multi-deck `deckIds` filtered against
  the active group).

### Disconnect from Settings

`replaceIntent({ view: 'connect' })`. We cannot clear forward history from
JS, so an entry like `[…, settings, connect]` survives — but the user can
still press forward (or, on iOS, a second-finger forward gesture) and land
on an intent that says `view: 'settings'` while the app is disconnected.

The popstate / state-applier handles this with a **preconditions check**:

- `review`, `edit`: require `connection === 'connected'`, an active
  group, **and** an active deck (Edit edits within a deck; Review's
  default `active-deck` scope needs one too — broader scopes are
  re-entry concerns handled by the scope persistence rules).
- `deck-picker`: requires `connection === 'connected'` and an active
  group.
- `settings`: requires `connection === 'connected'` only. Settings is
  **global** (see [`data-model.md`](./data-model.md) → "Topic prefix,
  groups, and decks") and its primary affordance is Disconnect, which
  must be reachable from a fresh-group state where no deck is active
  yet.
- `picker`, `connect`: no preconditions.

If any precondition isn't met, the listener falls back to the closest
supportable view: `replaceIntent({ view: 'connect' })` if disconnected,
otherwise `replaceIntent({ view: 'picker' })` if no active group,
otherwise `replaceIntent({ view: 'deck-picker' })` if no active deck.
Net effect: back/forward never lands the user in a UI state the store
can't actually support.

### scrollRestoration

`history.scrollRestoration = 'manual'` set once at boot. Otherwise the
browser tries to restore per-entry scroll on popstate, which jumps the user
mid-list when returning to a long Edit view. Each view manages its own
scroll (default: top on enter).

### Caveats

- **No hash routing.** Deep-linking a specific view, group, or word is not
  supported. A user who shares `https://…/mwords/#/review` lands on the
  default boot view, not Review. Adding routes is a separate feature.
- **Forward history isn't clearable.** Disconnect, group delete, and other
  destructive transitions leave stale forward entries reachable. The
  preconditions check in popstate keeps the UI consistent, but the user can
  see "nothing happened" on forward in those cases. Acceptable for v1.
- **iOS Safari fires popstate synchronously**, modern Chromium asynchronously.
  The design tolerates both because the close path doesn't depend on timing.
- **Native `<details>` / `<select>` dismissal**. Some browsers do *not*
  expose `<details>` open/close to history; back will not collapse the
  Import / Export `<details>` block. That's fine — it's a disclosure, not a
  modal. Same for native picker overlays.
- **Multi-tab.** Each tab has its own `history`, so back behaviour is per-tab.
  No coordination needed.

### Tests

`tests/history.test.ts` (using jsdom's `window.history` + a manual popstate
dispatch):

- `init()` calls `replaceState` with `{mwords: {view: 'connect'}}` exactly once.
- Each push-listed action above calls `pushState` once with the expected intent.
- Simulated `popstate` carrying a prior intent restores it on the store.
- Popstate carrying a connected-only intent while disconnected falls back to
  `view: 'connect'` and calls `replaceState`.
- Closing a modal via its button calls `history.back()` and not direct
  store mutation; popstate then clears the modal.

## UI design

Mobile-first. The app is designed to be used on a phone, in portrait, often
one-handed; desktop is a secondary target.

### Layout principles

- **Single column at all sizes.** No multi-column dashboards. On wide screens
  the content centers within a max-width (~640 px) container so it stays
  readable, with whitespace on the sides rather than a separate desktop layout.
- **Bottom nav bar.** The view switcher (Review / Edit / Settings), a
  single "Switch deck" button, the active Group › Deck breadcrumb, and
  the connection badge live in a sticky bottom bar — thumbs reach the
  bottom of a phone screen more easily than the top. There is no
  separate "Switch group" button: the deck picker reached from this
  button has an up-arrow in its header that pushes the group picker.
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
npm run format      # biome format --write
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

  One-time repo setup:

  1. **Settings → Pages → Build and deployment → Source: GitHub
     Actions**.
  2. **Settings → Environments → `github-pages` → Deployment
     branches and tags**: add `release` (or switch to *All
     branches*). The default rule allows only `main`/`master`, so
     a push from `release` is otherwise rejected at the deploy
     step with *"Branch is not allowed to deploy to github-pages
     due to environment protection rules."*

## Migration

**There is no v1 → v2 migration.** v2's topic parser only recognises
the new five-shape set (see [data-model.md](./data-model.md) →
"Validation"); legacy v1 retained messages (single-level
`<P>/g/<G>/words/<id>` / `<P>/g/<G>/srs/<id>`) are silently ignored.

The recommended path for a user moving from v1 to v2:

1. **Export from v1** (if data is wanted) using the v1 Export — keeps
   group names and word pairs in a JSON file.
2. **Switch to a fresh prefix** in the connection form (e.g. append
   `-v2` to the existing prefix) so v1 retained state is untouched
   and visible if the user wants to roll back.
3. **Import into v2.** The v1 file's `version: 1` is rejected; the
   user re-enters the deck names manually in v2 and re-pastes the
   word lists, or hand-edits the JSON to the v2 shape (single
   default deck per group) and imports that. Acceptable friction
   for what is a deliberate, infrequent change.
4. Once happy, the user can tombstone the old `<P>/...` retained
   state at the broker level (mosquitto_pub loop, flespi UI, or
   broker-specific subtree-clear) — mwords does not ship a button
   for this.

No code-level v1 compatibility paths exist in v2 — the simplification
is the whole point.

## Out of scope for v1

- Multi-user / shared groups (single user assumed; broker ACLs handle isolation).
- Conflict resolution beyond "last write wins".
- Importing/exporting Anki `.apkg` files.
- Audio, images, rich text on cards.
- A service worker / installable PWA.
- Analytics, telemetry.

## Out of scope for v2

- Moving a word between decks. Implementing it cleanly requires
  tombstone + re-create with a new id, which resets SRS state; an
  in-place move would need either a `Word.deckId` payload field
  (denormalising the topic address) or topic-rename support that
  MQTT doesn't have. Defer.
- Nested decks beyond one level (deck inside a deck inside a
  group). The schema is intentionally a strict two-level hierarchy.
- Cross-group review (one Review session spanning multiple groups
  at once). Each group is a hard scope boundary.
