# mwords — Data model

This document defines:

- the shape of every persisted record,
- the MQTT topic layout (the source of truth),
- the `localStorage` keys (the only client-local state).

The TypeScript types here are normative — the runtime `lib/mqtt/client.ts`
should `JSON.parse` + validate against them before publishing to stores.

## IDs

Every persistent entity — group, word, SRS state — is identified by an
**epoch-milliseconds timestamp at creation, stringified**:

```ts
const id = Date.now().toString();      // e.g. "1716285234567"
```

IDs:

- are **assigned exactly once**, at the moment of creation, and never change.
- are **stored as strings** even though the underlying value is a number.
  Stringifying once at creation avoids `Number` / `string` ambiguity at MQTT
  topic boundaries (topic levels are strings anyway) and keeps the type
  uniform across all uses.
- live in the **topic suffix** *and* are mirrored into the payload as an
  `id` field for `Group` and `Word`, so an in-memory record is
  self-contained (the picker, the SRS engine, and `compareWords` can use
  the record directly without threading the topic alongside it). `SrsState`
  derives its id from the topic since it's always joined to its `Word`
  anyway; `Settings` has no id (singleton topic).
- on a single client, collisions are essentially impossible (creation is
  user-driven, not loop-driven). Across two clients creating two records in
  the same millisecond, the broker's last-publish-wins on retained semantics
  resolves it — and these are different topics anyway (one per id).

## Topic prefix and groups

Every topic lives under a **base prefix**, with two namespaces underneath:
a literal `g/` segment holding **groups** (decks), and a global `settings`
topic shared across all groups.

- The **base prefix** is a connection-level setting stored in `localStorage`,
  default `mwords`. It namespaces this app on a broker that might host other
  things; for a private broker the default is fine.
- A **group** is the user-facing unit of organisation — roughly a "deck" in
  Anki terms ("German A1", "Spanish verbs", "Chemistry"). Group topics live
  under `<P>/g/<G>` where `<G>` is the group's numeric-string id.
- **Settings are global**, not per-group: SRS mode, direction, etc. live at
  `<P>/settings` and apply across every group. (If we ever want per-deck
  overrides, we can add a `<P>/g/<G>/settings` topic whose values override
  the global fields — but v1 is intentionally simple.)

The `g/` literal segment leaves room to add sibling namespaces later
(`<P>/users/<U>`, `<P>/imports/...`) without colliding with group ids.

Below, `<P>` denotes the base prefix and `<G>` denotes the active group's id.

### Group registry

Each group is announced by a retained marker at its root topic:

```
<P>/g/<G>          →   Group JSON
```

The client discovers groups by subscribing to `<P>/g/+` (single-level
wildcard) and reading the retained payloads. Creating a group means
publishing a `Group` to `<P>/g/<G>` with `retain: true`, where `<G>`
is a freshly-allocated `Date.now().toString()`. Tombstone publish (zero-byte,
retain) removes it — but group deletion is **out of scope for v1**.

**Strict discovery.** A group is visible only if `<P>/g/<G>` itself is
published. Words or SRS records under a group whose root marker is missing
are "orphans" and won't appear in the picker.

### Group names (display only)

Since `<G>` is now a numeric id, **the group name is purely a payload field**
and carries no topic-routing constraints:

- Length: up to **256 Unicode characters** (a generous cap; UI input
  enforces this).
- **Any characters allowed**, including `/`, `+`, `#`, spaces, emoji,
  newlines (the last is discouraged but not blocked) — none of them appear
  in topic strings anymore.
- **Leading/trailing whitespace is trimmed** on input before publishing.
- **Renaming is supported** — just re-publish the `Group` to the same
  `<P>/g/<G>` topic with the new `name`. The id stays put, so words and
  SRS records under the group are unaffected.

## Topics

| Topic                       | Retained | QoS | Payload         | Purpose                                                  |
|-----------------------------|----------|-----|-----------------|----------------------------------------------------------|
| `<P>/settings`              | yes      | 1   | `Settings` JSON | **Global** preferences (SRS mode, direction, …).         |
| `<P>/g/<G>`                 | yes      | 1   | `Group`         | Group registry marker. Listed by the picker.             |
| `<P>/g/<G>/words/<id>`      | yes      | 1   | `Word` JSON     | One word's definition. `<id>` is the word's creation ts. |
| `<P>/g/<G>/srs/<id>`        | yes      | 1   | `SrsState` JSON | Per-word scheduling state. `<id>` matches the word's id. |

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
<P>/g/<G>/words/+
<P>/g/<G>/srs/+
```

Wait for SUBACK + debounce → app is "synced" for this group. Switching
groups unsubscribes these two filters and resubscribes for the new group.
The global subscriptions from phase 1 are untouched.

### Deletion of a word

Publishing a **zero-byte payload** with `retain: true` clears the retained
message at a topic. We use this for word deletion, routed through the
PublishQueue:

```ts
await queue.publishTombstone(`${prefix}/g/${groupId}/words/${id}`);
await queue.publishTombstone(`${prefix}/g/${groupId}/srs/${id}`);
```

The store treats zero-byte messages as "tombstones" and removes the entry.

**Group deletion is out of scope for v1.** When we add it later, the
mechanic is the same — tombstone `<P>/g/<G>` plus every child topic — and
the UI will gate it behind explicit confirmation given the publish volume.

## Payload schemas

Payloads are deliberately minimal: no version numbers. `Group` and `Word`
mirror their id into the payload (`id` field, equal to the topic suffix)
so an in-memory record is self-contained; `SrsState` and `Settings` omit
it for the reasons above. All carry `created` and `updated` timestamps so
clients can show "last modified" info, sort by recency, and optionally
skip stale incoming retained messages on reconnect. All numeric timestamps
are **Unix epoch milliseconds**.

The `created` / `updated` pair appears in `Group`, `Word`, and `Settings`.
`SrsState` has its own equivalents (`lastReviewedAt`, `reviewCount`) and
doesn't repeat them.

### `Group` — `<P>/g/<G>`

```ts
type Group = {
  id: string;              // numeric string; equals the topic suffix <G>
  name: string;            // up to 256 Unicode chars, trimmed of edge whitespace
  created: number;         // epoch ms; equals Number(id) at creation
  updated: number;         // epoch ms; bumped on every publish (incl. rename)
};
```

Example:
`{ "id": "1716285234567", "name": "German A1", "created": 1716285234567, "updated": 1716285234567 }`

Renaming = publish a `Group` to the same topic with a different `name`,
the same `id` and `created`, and a fresh `updated` (`Date.now()`).

### `Word` — `<P>/g/<G>/words/<id>`

```ts
type Word = {
  id: string;              // numeric string; equals the topic suffix
  text: string;            // the prompt side (e.g., "der Hund")
  translation: string;     // the answer side (e.g., "the dog")
  created: number;         // epoch ms; equals Number(id) at creation
  updated: number;         // epoch ms; bumped on every publish
};
```

A word has just `text` and `translation` as user-visible content — no
tags, no notes. SRS state lives in its own topic (joined client-side by
matching the `id` to the topic suffix `<P>/g/<G>/srs/<id>`).

### `SrsState` — `<P>/g/<G>/srs/<id>`

Per-card scheduling state. The `<id>` matches the related word's id, so a
word and its SRS state are joined client-side by topic-suffix equality.
Both algorithms (SM-2 and weighted random) read and write the same record;
they use different subsets of fields. See [srs.md](./srs.md) for algorithm
specifics.

```ts
type Grade = 'again' | 'hard' | 'good' | 'easy';

type SrsState = {
  // SM-2 fields
  ease: number;                  // ease factor, starts at 2.5
  intervalDays: number;          // current interval, in days
  reps: number;                  // successful reps in a row (resets on Again)
  lapses: number;                // total lapses (Again grades) ever
  due: number;                   // epoch ms; the card is next due at this instant

  // Shared / all modes
  lastGrade: Grade | null;
  lastReviewedAt: number | null; // epoch ms
  reviewCount: number;           // total times this card has been graded
};
```

A brand-new word has no `SrsState` topic published yet. The store treats a
missing entry as the "new card" default:

```ts
const defaultSrs = (): SrsState => ({
  ease: 2.5,
  intervalDays: 0,
  reps: 0,
  lapses: 0,
  due: Date.now(),               // due immediately
  lastGrade: null,
  lastReviewedAt: null,
  reviewCount: 0,
});
```

### `Settings` — `<P>/settings`

Global, single instance. Applies across every group. If the topic is absent
on first connect, the client uses the documented defaults below; the first
user-initiated change publishes the topic (with `created` set to that
moment).

```ts
type SrsMode = 'sm2' | 'weighted-random' | 'serial';
type Direction = 'text' | 'translation';

type Settings = {
  srsMode: SrsMode;              // default: 'sm2'
  direction: Direction;          // which side is shown first; default: 'text'
  created: number;               // epoch ms; the moment the topic was first published
  updated: number;               // epoch ms; bumped on every publish
};
```

- `direction: 'text'` — show `text`, hide `translation`; user recalls
  `translation`.
- `direction: 'translation'` — show `translation`, hide `text`; user recalls
  `text` (i.e., learn from both sides by flipping the setting).

## LocalStorage

Exactly **one** key:

| Key                | Value (JSON-encoded)                                          |
|--------------------|---------------------------------------------------------------|
| `mwords:connection`| `{ url, username, password, prefix, lastGroup? }`             |

```ts
type StoredConnection = {
  url: string;             // wss://broker.example.com:8884/mqtt
  username: string;
  password: string;
  prefix: string;          // base topic prefix, default "mwords"
  lastGroup?: string;      // optional: id of the most-recently active group
                           // (a numeric string like "1716285234567")
};
```

- `prefix` defaults to `"mwords"`. The connection form lets the user override
  it (single segment, no `/`).
- `lastGroup` is a UX convenience: on boot, if it resolves to a group id
  that's still present in the discovered registry, we skip the picker. If
  not (e.g., the group was deleted on another device, or this is a fresh
  install), we show the picker. There's also a manual "switch group"
  affordance so the user is never trapped in one group.

We deliberately keep no card or SRS cache in `localStorage` — the MQTT
retained snapshot is authoritative on every load. IndexedDB holds only the
publish queue (see `design.md` → "Offline behavior").

### Security note

Storing a broker password in `localStorage` is the standard trade-off for a
no-backend app and is not worse than equivalents (Anki Web's session cookie,
JWT in storage, etc.). Mitigations a user can apply on their broker:

- Per-user broker accounts with ACLs restricted to their prefix.
- Short-lived JWT auth (if the broker supports it).
- Keep the deployment private (GitHub Pages on a private repo, or local-only).

We will **not** transmit credentials anywhere except the configured broker over WSS.

## Publish patterns

All publishes use `qos: 1, retain: true` and route through the PublishQueue
(`queue.publishIntent(topic, payload)` for content, `queue.publishTombstone(topic)`
for deletions). The queue handles QoS/retain flags; call sites just supply
topic + payload.

```ts
// Create a new group
const groupId = Date.now().toString();
const now = Number(groupId);
await queue.publishIntent(`${prefix}/g/${groupId}`,
  { id: groupId, name: trimmedName, created: now, updated: now } satisfies Group);

// Rename a group (re-publish to the same topic)
await queue.publishIntent(`${prefix}/g/${existing.id}`,
  { id: existing.id, name: newTrimmedName,
    created: existing.created, updated: Date.now() } satisfies Group);

// Add a new word
const wordId = Date.now().toString();
const ts = Number(wordId);
await queue.publishIntent(`${prefix}/g/${groupId}/words/${wordId}`,
  { id: wordId, text, translation, created: ts, updated: ts } satisfies Word);

// Update an existing word (same topic; broker overwrites retained)
await queue.publishIntent(`${prefix}/g/${groupId}/words/${word.id}`,
  { id: word.id, text: newText, translation: newTranslation,
    created: word.created, updated: Date.now() } satisfies Word);

// Record a review result
const newSrs = sm2.transition(currentSrs, grade, Date.now());
await queue.publishIntent(`${prefix}/g/${groupId}/srs/${wordId}`, newSrs);

// Change a global setting
await queue.publishIntent(`${prefix}/settings`,
  { ...settings, srsMode: 'weighted-random', updated: Date.now() });

// Delete a word
await queue.publishTombstone(`${prefix}/g/${groupId}/words/${wordId}`);
await queue.publishTombstone(`${prefix}/g/${groupId}/srs/${wordId}`);
```

## Validation

Every incoming MQTT payload runs through a small runtime validator before
hitting a store. The validators are called with both the parsed payload
and the topic-derived id (where applicable), so cross-checks happen in one
place:

- `JSON.parse` (catch syntax errors → log and drop).
- Type-narrow with hand-written guards: `isGroup(x, topicId): x is Group`,
  `isWord(x, topicId): x is Word`, `isSrsState(x, topicId): x is SrsState`,
  `isSettings(x): x is Settings`. No `zod`/`valibot` in v1 — the schemas
  are small and the validators are <30 lines each.
- **Topic/payload id consistency.** For `Group` and `Word`, `payload.id`
  **must equal** the topic suffix; if it doesn't, drop the message with a
  warning that includes both values. (Mismatches indicate a hand-publish
  error or a misbehaving client and should not be silently accepted —
  trusting the wrong id would let a payload "hijack" the wrong topic.)
- **Range checks.** `created` and `updated` must be finite positive
  numbers; `created <= updated`; `updated <= Date.now() + clockSkewBudget`
  (e.g. 5 min) — reject otherwise. Likewise `Group.name.length <= 256`
  and is trimmed.
- On validation failure: log the topic + payload, drop the message,
  surface a toast in dev mode only.

This protects the UI from a corrupt or hand-edited retained message
(which is easy to produce with `mosquitto_pub`) and from misbehaving
peers publishing payloads with the wrong id.
