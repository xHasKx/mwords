# mwords — Data model

This document defines:

- the shape of every persisted record,
- the MQTT topic layout (the source of truth),
- the `localStorage` keys (the only client-local state).

The TypeScript types here are normative — the runtime `lib/mqtt/client.ts`
should `JSON.parse` + validate against them before publishing to stores.

## IDs

Every persistent entity — group, deck, word, SRS state — is identified by an
**epoch-milliseconds timestamp at creation, stringified**:

```ts
const id = Date.now().toString();      // e.g. "1716285234567"
```

The id is the **only ms-based value in the data model**. Every other
timestamp (the `created` / `updated` payload fields, the SRS `due`, and
the MQTT 5 `timestamp` User Property) is in **epoch seconds** (a
fractional `number`, e.g. `1716285234.567`). On creation, code uses both
representations from the same `Date.now()` call:

```ts
const tmNow = Date.now();
const id = tmNow.toString();           // ms, string — for the topic suffix
record.created = tmNow / 1000;         // seconds, number — for the payload
record.updated = tmNow / 1000;
```

So for `Group`, `Deck`, and `Word`, `record.created === Number(record.id) / 1000`
at creation. Subsequent `updated` bumps use `Date.now() / 1000`.
(`SrsState` has no `created` field; `Settings` has neither `id` nor
`created`.)

IDs:

- are **assigned exactly once**, at the moment of creation, and never change.
- are **stored as strings** even though the underlying value is a number.
  Stringifying once at creation avoids `Number` / `string` ambiguity at MQTT
  topic boundaries (topic levels are strings anyway) and keeps the type
  uniform across all uses.
- live in the **topic suffix** *and* are mirrored into the payload as an
  `id` field for `Group`, `Deck`, `Word`, and `SrsState`, so an in-memory
  record is self-contained (the picker, the SRS engine, and `compareWords`
  can use the record directly without threading the topic alongside it).
  `Settings` has no id (singleton topic).
- a deck `id` does **not** encode its parent group; the parent is the
  topic location (the `<G>` segment between `g/` and `d/`). Same for
  words and SRS state — their topic encodes the deck and group; the
  payload only carries the leaf `id`.
- on a single client, collisions are essentially impossible (creation is
  user-driven, not loop-driven). Across two clients creating two records in
  the same millisecond, the broker's last-publish-wins on retained semantics
  resolves it — and these are different topics anyway (one per id).

## Topic prefix, groups, and decks

Every topic lives under a **base prefix**, with three nested namespaces:
groups (literal `g/`), decks inside each group (literal `d/`), and a
global `settings` topic shared across the whole prefix.

- The **base prefix** is a connection-level setting stored in `localStorage`,
  default `mwords`. It namespaces this app on a broker that might host other
  things; for a private broker the default is fine.
- A **group** is the top-level container — a *language* or *project*
  ("German", "Spanish", "Chemistry"). Group markers live at `<P>/g/<G>`
  where `<G>` is the group's numeric-string id.
- A **deck** is a leaf container of words inside a group — the
  Anki-deck equivalent ("A1 Verbs", "Food", "Lesson 3"). Deck markers
  live at `<P>/g/<G>/d/<D>` where `<D>` is the deck's numeric-string
  id; words and SRS records live under `<P>/g/<G>/d/<D>/...`.
- **Settings are global**, not per-group or per-deck: SRS mode,
  direction, etc. live at `<P>/settings` and apply across the entire
  prefix.

The `g/` and `d/` literal segments leave room for sibling namespaces
later (`<P>/users/<U>`, `<P>/g/<G>/imports/...`) without colliding with
ids.

Below, `<P>` denotes the base prefix, `<G>` the active group's id, and
`<D>` the active deck's id.

### Group registry

Each group is announced by a retained marker at its root topic:

```
<P>/g/<G>          →   Group JSON
```

The client discovers groups by subscribing to `<P>/g/+` (single-level
wildcard) and reading the retained payloads. Creating a group means
publishing a `Group` to `<P>/g/<G>` with `retain: true`, where `<G>`
is a freshly-allocated `Date.now().toString()`. Tombstone publish (zero-byte,
retain) removes it; see [`design.md`](./design.md) → "Group deletion".

**Strict discovery.** A group is visible only if `<P>/g/<G>` itself is
published. Decks, words, or SRS records under a group whose root
marker is missing are "orphans" and won't appear in any picker.

### Deck registry

Each deck inside a group is announced by a retained marker at its root topic:

```
<P>/g/<G>/d/<D>    →   Deck JSON
```

For the active group, the client discovers decks by subscribing to
`<P>/g/<G>/d/+` and reading the retained payloads. Creating a deck means
publishing a `Deck` to `<P>/g/<G>/d/<D>` with `retain: true`, where
`<D>` is a freshly-allocated `Date.now().toString()` (independent of any
group id). Tombstone publish removes it; see [`design.md`](./design.md)
→ "Deck deletion".

**Strict discovery extends one level deeper.** A deck is visible only
if both `<P>/g/<G>` and `<P>/g/<G>/d/<D>` are published. Words and SRS
records under a deck whose marker is missing are orphans.

### Group and deck names (display only)

Since `<G>` and `<D>` are numeric ids, **group and deck names are purely
payload fields** and carry no topic-routing constraints:

- Length: `1 <= name.length <= 256` after trim (a generous upper cap;
  empty / whitespace-only names rejected by the UI and validator).
- **Any characters allowed**, including `/`, `+`, `#`, spaces, emoji,
  newlines (the last is discouraged but not blocked) — none of them appear
  in topic strings.
- **Leading/trailing whitespace is trimmed** on input before publishing.
- **Renaming is supported** — re-publish the `Group` or `Deck` to the
  same topic with the new `name`. The id stays put, so children
  (decks under a renamed group; words / SRS under a renamed deck) are
  unaffected.
- Names are **not unique** across siblings — two decks in the same
  group may share a name; the picker shows both. Uniqueness is by
  `id`, not by name.

## Topics

| Topic                            | Retained | QoS | Payload         | Purpose                                                  |
|----------------------------------|----------|-----|-----------------|----------------------------------------------------------|
| `<P>/settings`                   | yes      | 1   | `Settings` JSON | **Global** preferences (SRS mode, direction, …).         |
| `<P>/g/<G>`                      | yes      | 1   | `Group`         | Group registry marker. Listed by the group picker.       |
| `<P>/g/<G>/d/<D>`                | yes      | 1   | `Deck`          | Deck registry marker. Listed by the deck picker.         |
| `<P>/g/<G>/d/<D>/words/<id>`     | yes      | 1   | `Word` JSON     | One word's definition. `<id>` is the word's creation ts. |
| `<P>/g/<G>/d/<D>/srs/<id>`       | yes      | 1   | `SrsState` JSON | Per-word scheduling state. `<id>` matches the word's id. |

### Subscription pattern (two phases)

**Phase 1 — discovery + global settings** (immediately after connect, in a
single SUBSCRIBE with both filters):

```
<P>/g/+
<P>/settings
```

Wait for SUBACK + debounce → we now have a `Map<groupId, Group>` and
the global `Settings`. Show the group picker (unless `lastGroup` from
`localStorage` resolves to a still-existing group, in which case auto-select
it).

We **keep** both subscriptions active for the lifetime of the connection so
that groups created or renamed on other devices appear in the picker live,
and so that settings changes from other devices propagate immediately.

**Phase 2 — group-scoped** (after the user picks/creates a group `<G>`):

```
<P>/g/<G>/d/+
<P>/g/<G>/d/+/words/+
<P>/g/<G>/d/+/srs/+
```

Wait for SUBACK + debounce → app is "synced" for this group. The
single `+` wildcard at the deck level loads every deck's words and SRS
state in one go; switching decks **within** a group is then an
in-memory filter change, with no further SUBSCRIBE / UNSUBSCRIBE
round-trip. Switching to a different *group* unsubscribes all three
filters and resubscribes for the new group's `<G>`. The global
subscriptions from phase 1 are untouched.

This loads more retained data than a strict per-deck subscribe would,
but the trade is intentional: multi-deck and whole-group review modes
(see [`design.md`](./design.md) → "Review scope") become pure
in-memory operations, and per-deck switching feels instant.

### Deletion of a word

Publishing a **zero-byte payload** with `retain: true` clears the retained
message at a topic. We use this for word deletion, routed through the
PublishQueue:

```ts
await queue.publishTombstone(`${prefix}/g/${groupId}/d/${deckId}/words/${id}`);
await queue.publishTombstone(`${prefix}/g/${groupId}/d/${deckId}/srs/${id}`);
```

The store treats zero-byte messages as "tombstones" and removes the entry.

**Group and deck deletion** use the same mechanic — tombstone the
marker plus every child topic. See [`design.md`](./design.md) →
"Group deletion" / "Deck deletion" for the wildcard-subtree publish
shape used on flespi-class brokers (`<P>/g/<G>/#` and
`<P>/g/<G>/d/<D>/#`).

## Payload schemas

Payloads are deliberately minimal: no version numbers. `Group`, `Deck`,
`Word`, and `SrsState` mirror their id into the payload (`id` field,
equal to the topic suffix) so an in-memory record is self-contained.
`Settings` omits it (singleton topic). None of the records encode their
parent — the topic is the address, and the store synthesizes the
parent relationship from the parsed topic on receive.

`Group`, `Deck`, and `Word` carry `created` and `updated` timestamps to
support "last modified" UI and recency sorting. `Settings` and
`SrsState` carry only `updated` (no `created`). All five types use
`updated` uniformly, which is also what drives the LWW gate on incoming
retained messages (see [`design.md`](./design.md) → Application
lifecycle step 9). All numeric timestamps are **Unix epoch seconds**
(fractional, ms-precision preserved — `Date.now() / 1000`).

The source of truth is the broker. Retained-topic semantics give us
last-publish-wins at the broker layer — whichever publish lands last
becomes the retained value. The client adds a thin LWW gate on incoming
messages using the `timestamp` MQTT 5 User Property (see
[`design.md`](./design.md) → Application lifecycle step 9), so a pending
local edit isn't briefly overwritten by a stale retained replay during
reconnect.

### `Group` — `<P>/g/<G>`

```ts
type Group = {
  id: string;              // numeric string (ms); equals the topic suffix <G>
  name: string;            // up to 256 Unicode chars, trimmed of edge whitespace
  created: number;         // epoch seconds; equals Number(id) / 1000 at creation
  updated: number;         // epoch seconds; bumped on every publish (incl. rename)
};
```

Example:
`{ "id": "1716285234567", "name": "German A1", "created": 1716285234.567, "updated": 1716285234.567 }`

Renaming = publish a `Group` to the same topic with a different `name`,
the same `id` and `created`, and a fresh `updated` (`Date.now() / 1000`).

### `Deck` — `<P>/g/<G>/d/<D>`

```ts
type Deck = {
  id: string;              // numeric string (ms); equals the topic suffix <D>
  name: string;            // up to 256 Unicode chars, trimmed of edge whitespace
  created: number;         // epoch seconds; equals Number(id) / 1000 at creation
  updated: number;         // epoch seconds; bumped on every publish (incl. rename)
};
```

Example:
`{ "id": "1716285234890", "name": "A1 Verbs", "created": 1716285234.890, "updated": 1716285234.890 }`

Identical shape to `Group`. The parent group is the topic location
(`<G>`), not a payload field. Renaming = re-publish to the same topic
with a new `name`, the same `id` and `created`, and a fresh `updated`.

### `Word` — `<P>/g/<G>/d/<D>/words/<id>`

```ts
type Word = {
  id: string;              // numeric string (ms); equals the topic suffix
  text: string;            // the prompt side (e.g., "der Hund")
  translation: string;     // the answer side (e.g., "the dog")
  created: number;         // epoch seconds; equals Number(id) / 1000 at creation
  updated: number;         // epoch seconds; bumped on every publish
};
```

A word has just `text` and `translation` as user-visible content — no
tags, no notes. SRS state lives in its own topic (joined client-side by
matching the `id` to the topic suffix `<P>/g/<G>/d/<D>/srs/<id>`).

### `SrsState` — `<P>/g/<G>/d/<D>/srs/<id>`

Per-card scheduling state. The `id` (and the topic suffix) matches the
related word's id, so a word and its SRS state are joined client-side by
equality. The dispatcher (`applyGrade`) runs the SM-2 transition on every
grade regardless of `srsMode`, so all fields are always populated and
mode-switching never loses history. See [srs.md](./srs.md) for the
algorithm specifics and how each picker mode uses (or ignores) the
schedule fields.

```ts
type Grade = 'again' | 'hard' | 'good' | 'easy';

type SrsState = {
  id: string;                    // numeric string; equals the topic suffix
                                 // and the related Word.id

  // SM-2 fields (always written by applyGrade)
  ease: number;                  // ease factor, starts at 2.5
  intervalDays: number;          // current interval, integer days
  reps: number;                  // successful reps in a row (resets on Again)
  lapses: number;                // total lapses (Again grades) ever
  due: number;                   // epoch seconds; the card is next due at this instant

  // Last-review fields
  lastGrade: Grade | null;
  reviewCount: number;           // total times this card has been graded
  updated: number;               // epoch seconds; set to `now` on every
                                 // applyGrade — i.e. the time of the most
                                 // recent review. Also serves as the LWW
                                 // timestamp for incoming SRS messages.
                                 // 0 on a brand-new card (never reviewed).
};
```

A brand-new word has no `SrsState` topic published yet. The store treats a
missing entry as the "new card" default:

```ts
const defaultSrs = (id: string): SrsState => ({
  id,
  ease: 2.5,
  intervalDays: 0,
  reps: 0,
  lapses: 0,
  due: Date.now() / 1000,        // due immediately (seconds)
  lastGrade: null,
  reviewCount: 0,
  updated: 0,                    // never reviewed yet
});
```

### `Settings` — `<P>/settings`

Global, single instance. Applies across every group. If the topic is absent
on first connect, the client uses the documented defaults below; the first
user-initiated change publishes the topic.

```ts
type SrsMode = 'sm2' | 'weighted-random' | 'serial';
type Direction = 'text' | 'translation';

type Settings = {
  srsMode: SrsMode;              // default: 'sm2'
  direction: Direction;          // which side is shown first; default: 'text'
  updated: number;               // epoch seconds; bumped on every publish.
                                 // In-memory default is 0 (never-published
                                 // sentinel, matching SrsState's convention)
                                 // so the first incoming Settings publish
                                 // from any peer wins the LWW gate.
};
```

- `direction: 'text'` — show `text`, hide `translation`; user recalls
  `translation`.
- `direction: 'translation'` — show `translation`, hide `text`; user recalls
  `text` (i.e., learn from both sides by flipping the setting).

## LocalStorage

Exactly **one** key:

| Key                | Value (JSON-encoded)                                                          |
|--------------------|-------------------------------------------------------------------------------|
| `mwords:connection`| `{ url, username, password, prefix, lastGroup?, lastDeck?, lastReviewScope?, autoconnect? }` |

```ts
type StoredConnection = {
  url: string;             // wss://broker.example.com:8884/mqtt
  username: string;
  password: string;
  prefix: string;          // base topic prefix, default "mwords".
                           // single MQTT topic level: at least 1 char,
                           // no `/`, `+`, `#`, null byte, or whitespace.
  lastGroup?: string;      // optional: id of the most-recently active group
                           // (a numeric string like "1716285234567")
  lastDeck?: string;       // optional: id of the most-recently active deck.
                           // Single id, NOT per-group — on boot we sanity-
                           // check it resolves to a deck inside `lastGroup`
                           // and drop it if not. Cleared when the user
                           // switches groups.
  lastReviewScope?:        // optional: persisted Review scope. Restored on
                           // boot when `lastDeck` resolves. Defaults to
                           // `{ kind: 'active-deck' }` if absent. See
                           // design.md → "Review scope" for the in-memory
                           // shape (identical here).
    | { kind: 'active-deck' }
    | { kind: 'decks'; deckIds: string[] }
    | { kind: 'group' };
  autoconnect?: boolean;   // when true, boot skips the connect form and
                           // calls connect() immediately. Set by the form's
                           // Autoconnect checkbox; cleared by Settings →
                           // Disconnect (and naturally lost on Disconnect &
                           // forget). Treated as false when missing.
};
```

- `prefix` defaults to `"mwords"`. The connection form lets the user override
  it; see the inline rules in `StoredConnection.prefix` above.
- `lastGroup` is a UX convenience: on boot, if it resolves to a group id
  that's still present in the discovered registry, we skip the group
  picker. If not (e.g., the group was deleted on another device, or this
  is a fresh install), we show the group picker.
- `lastDeck` is the next UX convenience down: on boot, after `lastGroup`
  resolves, we check that `lastDeck` resolves to a deck inside that
  group. If yes, restore it as the active deck and skip the deck picker
  too (landing the user back in Review/Edit). If no, drop `lastDeck`
  and show the deck picker. When the user switches groups via the
  picker, `lastDeck` is cleared in the same write that updates
  `lastGroup`.
- `lastReviewScope` is restored alongside `lastDeck`. Multi-deck
  selections (`{ kind: 'decks', deckIds }`) are filtered on restore to
  only include deck ids still present in the active group — if the
  filtered list is empty, the scope falls back to
  `{ kind: 'active-deck' }`.
- A "switch deck" affordance from the nav bar reaches the deck picker
  at any time; from the deck picker, an up-arrow reaches the group
  picker.
- `autoconnect` defaults to false. Each Save & connect submission writes
  whatever the checkbox shows; each Settings → Disconnect resets it to
  false. The intent is "this connection is durable enough that I want it
  re-established on the next page load"; clicking Disconnect is the user
  expressing they want to edit details next time, so the flag clears.

We deliberately keep no card or SRS cache in `localStorage` — the MQTT
retained snapshot is authoritative on every load. IndexedDB holds only the
publish queue (see `design.md` → "Offline behavior").

### Security note

Storing a broker password in `localStorage` is the standard trade-off for a
no-backend app. Mitigations a user can apply on their broker:

- Per-user broker accounts with ACLs restricted to their prefix.
- Short-lived JWT auth (if the broker supports it).
- Keep the deployment private (GitHub Pages on a private repo, or local-only).

We will **not** transmit credentials anywhere except the configured broker over WSS.

## Publish patterns

All publishes use `qos: 1, retain: true` and route through the PublishQueue.
The queue also attaches a single MQTT 5 `timestamp` User Property to every
publish — see [`design.md`](./design.md) → "Broker requirements" for the
spec. Call sites supply topic + payload and never think about QoS / retain
flags or user properties:

```ts
// Persist a content intent. payload is serialized to JSON (then UTF-8).
queue.publishIntent(topic: string, payload: Record<string, unknown>): Promise<void>;

// Persist a tombstone intent (zero-byte retain, deletes the topic). Sugar for
// publishing an empty Uint8Array with retain: true.
queue.publishTombstone(topic: string): Promise<void>;
```

Both return a promise that resolves **once the intent is persisted to
IndexedDB** — not on PUBACK. The actual broker round-trip is a background
process that never blocks UI: the store's optimistic update has already
taken effect by the time the promise resolves, and the queue flushes
asynchronously when the connection allows.

```ts
// Create a new group
const tmNow = Date.now();
const groupId = tmNow.toString();
const tsNow = tmNow / 1000;
await queue.publishIntent(`${prefix}/g/${groupId}`,
  { id: groupId, name: trimmedName, created: tsNow, updated: tsNow } satisfies Group);

// Rename a group (re-publish to the same topic)
await queue.publishIntent(`${prefix}/g/${existing.id}`,
  { id: existing.id, name: newTrimmedName,
    created: existing.created, updated: Date.now() / 1000 } satisfies Group);

// Create a new deck inside a group (identical id/timestamps pattern)
const tmDeck = Date.now();
const deckId = tmDeck.toString();
const tsDeck = tmDeck / 1000;
await queue.publishIntent(`${prefix}/g/${groupId}/d/${deckId}`,
  { id: deckId, name: trimmedDeckName, created: tsDeck, updated: tsDeck } satisfies Deck);

// Rename a deck (re-publish to the same topic)
await queue.publishIntent(`${prefix}/g/${groupId}/d/${existingDeck.id}`,
  { id: existingDeck.id, name: newTrimmedName,
    created: existingDeck.created, updated: Date.now() / 1000 } satisfies Deck);

// Add a new word (lives under the active deck)
const tmWord = Date.now();
const wordId = tmWord.toString();
const tsWord = tmWord / 1000;
await queue.publishIntent(`${prefix}/g/${groupId}/d/${deckId}/words/${wordId}`,
  { id: wordId, text, translation, created: tsWord, updated: tsWord } satisfies Word);

// Update an existing word (same topic; broker overwrites retained)
await queue.publishIntent(`${prefix}/g/${groupId}/d/${deckId}/words/${word.id}`,
  { id: word.id, text: newText, translation: newTranslation,
    created: word.created, updated: Date.now() / 1000 } satisfies Word);

// Record a review result. Non-commit action — fire and forget; no `await`.
// See design.md → Application lifecycle step 8.
const newSrs = sm2.transition(currentSrs, grade, Date.now() / 1000);
queue.publishIntent(`${prefix}/g/${groupId}/d/${deckId}/srs/${word.id}`, newSrs);

// Change a global setting
await queue.publishIntent(`${prefix}/settings`,
  { ...settings, srsMode: 'weighted-random', updated: Date.now() / 1000 } satisfies Settings);

// Delete a word
await queue.publishTombstone(`${prefix}/g/${groupId}/d/${deckId}/words/${wordId}`);
await queue.publishTombstone(`${prefix}/g/${groupId}/d/${deckId}/srs/${wordId}`);
```

Words and SRS records live under the deck whose `<D>` segment is in
their topic. A word is **never moved between decks** in v1 — moving
would require a tombstone + re-create with a new id (and would reset
its SRS state). Out of scope.

## Validation

Every incoming MQTT payload runs through a small runtime validator before
hitting a store. The validators are called with both the parsed payload
and the topic-derived id (where applicable), so cross-checks happen in one
place:

- **Zero-byte short-circuit (tombstone path).** Inspect the raw payload's
  byte length **before** any JSON work. If it's `0`, the message is a
  retained-delete tombstone — dispatch a tombstone signal to the
  appropriate store keyed by the topic-derived id and return. No
  `JSON.parse`, no type guard, no range checks (none of them would
  succeed on an empty buffer anyway: `JSON.parse("")` throws). The LWW
  gate (see [`design.md`](./design.md) → Application lifecycle step 9)
  is applied first using the message's `timestamp` MQTT 5 User
  Property — the gate operates on the wire-level UP, not on a parsed
  payload.
- `JSON.parse` (catch syntax errors → log and drop).
- Type-narrow with hand-written guards: `isGroup(x, topicId): x is Group`,
  `isDeck(x, topicId): x is Deck`, `isWord(x, topicId): x is Word`,
  `isSrsState(x, topicId): x is SrsState`, `isSettings(x): x is Settings`.
  No `zod`/`valibot` in v1 — the schemas are small and the validators are
  <30 lines each.
- **Topic/payload id consistency.** For `Group`, `Deck`, `Word`, and
  `SrsState`, `payload.id` **must equal** the topic suffix; if it
  doesn't, drop the message with a warning that includes both values.
  (Mismatches indicate a hand-publish error or a misbehaving client —
  trusting the wrong id would let a payload effectively hijack the
  wrong topic.) The validator does **not** cross-check the `<G>` or
  `<D>` segments — they're addressed by the topic parser, not echoed
  in the payload.
- **Range checks (closed list).** Beyond `JSON.parse` + type guards,
  the validator applies range checks **only** to the fields listed
  here; every other numeric / string field is accepted as-is once it
  passes the type guard.
  - `updated`, on every payload type, must be a finite non-negative
    number. (The `0` sentinel used by in-memory `SrsState` defaults
    is acceptable; such records are never published.)
  - `created`, on `Group`, `Deck`, and `Word`, must be a finite
    non-negative number with `created <= updated`.
  - `Group.name` and `Deck.name` are trimmed of edge whitespace and
    must satisfy `1 <= name.length <= 256` after trim (empty names
    rejected).
  - No upper bound against `Date.now()` — clock skew between devices
    would otherwise cause valid messages to be dropped.

  Other `SrsState` fields (`ease`, `intervalDays`, `due`, `reps`,
  `lapses`, `reviewCount`), `Word.text`, `Word.translation`, and the
  `Settings` enum fields rely on the type guard's `typeof` / literal
  checks. The broker is the source of truth and the worst case for a
  weird-but-typed value (`ease = 0.1`, `text = ""`) is a single odd
  card, not a corrupted store — so we don't pay the validator-surface
  cost of constraining them further.
- **Topic parsing.** `lib/mqtt/topics.ts` recognises five shapes:
  `<P>/settings`, `<P>/g/<G>`, `<P>/g/<G>/d/<D>`,
  `<P>/g/<G>/d/<D>/words/<id>`, `<P>/g/<G>/d/<D>/srs/<id>`. Anything
  else (including the old v1 `<P>/g/<G>/words/<id>` shape) is dropped
  silently. There is no compatibility shim — old-shape data on the
  broker is invisible to v2 (see [`design.md`](./design.md) →
  "Migration").
- On validation failure: log the topic + payload, drop the message,
  surface a toast in dev mode only.

This protects the UI from a corrupt or hand-edited retained message
(which is easy to produce with `mosquitto_pub`) and from misbehaving
peers publishing payloads with the wrong id.
