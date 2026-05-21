# mwords — Scheduling algorithms

mwords supports three scheduling modes, all selected via `settings.srsMode`
(see [data-model.md](./data-model.md)):

- `sm2` — classic SuperMemo-2 spaced-repetition. **Default.**
- `weighted-random` — no due dates, picks any word with probability weighted
  by recent difficulty.
- `serial` — walks the deck in stable, intrinsic list order. No scheduling.

All three modes read and write the same `SrsState` record, but use different
subsets of fields. The dispatcher (`lib/srs/picker.ts`) routes calls to the
appropriate implementation. Switching modes does **not** reset state, so a
user can flip between them freely without losing SM-2 history.

## Shared types

```ts
type Grade = 'again' | 'hard' | 'good' | 'easy';

// Numeric quality for SM-2: again=0, hard=3, good=4, easy=5.
const QUALITY: Record<Grade, number> = {
  again: 0, hard: 3, good: 4, easy: 5,
};
```

## SM-2 (`lib/srs/sm2.ts`)

Faithful implementation of the SM-2 algorithm published by P. A. Wozniak in 1987.
Anki used a variant of this from inception until v23.10. For this app a textbook
SM-2 is enough — we don't need Anki's learning steps, leech detection, or
new-card limits in v1.

### State (relevant fields)

```
ease           — float, default 2.5, clamped to >= 1.3
intervalDays   — integer days until next review, default 0
reps           — successful reps in a row, default 0; resets to 0 on Again
due            — epoch ms of next review
```

### Transition

Given the current `state`, a `grade`, and a "now" timestamp:

```
q = QUALITY[grade]

if q < 3:               // Again
  reps = 0
  intervalDays = 0      // due again immediately (same session)
  lapses += 1
else:
  if reps == 0:
    intervalDays = 1
  elif reps == 1:
    intervalDays = 6
  else:
    intervalDays = round(state.intervalDays * ease)
  reps += 1

ease = max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
due  = now + intervalDays days
```

Notes:

- `Hard` (`q=3`) shrinks `ease` a little but still advances the interval.
- `Easy` (`q=5`) grows `ease`; the next interval is longer.
- `intervalDays = 0` after Again means "show again this session" — the
  review picker filters by `due <= now`, so it will reappear.

### Picking the next card (SM-2 mode)

1. Filter words to those whose `srs.due <= now` (or have no `srs` record yet,
   i.e. brand-new cards — those default to "due now").
2. If the filtered set is empty, the session is done — show a "no cards due"
   message with the time until the next card.
3. Otherwise, sort by `due` ascending and return the first. Ties broken by
   `id` ascending (numerically — since `id` is the creation epoch-ms, lower
   id = older card = served first).

### Why classic SM-2 and not FSRS?

FSRS (Anki's default since 2024) is more accurate but:

- Adds 4+ extra state fields per card (stability, difficulty, …).
- Needs a parameter vector tuned to the user's review history (Anki ships
  defaults but recommends optimization).
- A correct implementation is ~10× the code.

For an MVP with no review history to tune from, classic SM-2 gives 90% of
the benefit in a tiny, auditable module. FSRS can be added later as a third
`srsMode` without breaking the schema (the SM-2 fields stay populated; FSRS
adds its own).

## Weighted random (`lib/srs/weighted.ts`)

A simpler mode for "just drill me" use. Every word is always eligible; the
algorithm only influences **probability of being picked**, not whether.

### Weights

```
weight(srsState):
  switch srsState.lastGrade:
    case null:    return 1.0       // never reviewed
    case 'again': return 4.0
    case 'hard':  return 2.0
    case 'good':  return 1.0
    case 'easy':  return 0.3
```

### Transition

Weighted random doesn't need due dates, but we still record the grade so
SM-2 history accumulates if the user switches modes later. Each review:

```
srsState.lastGrade      = grade
srsState.lastReviewedAt = now
srsState.reviewCount   += 1
```

We **also** apply the SM-2 ease/interval update in weighted mode. That way
the SM-2 state stays "live" and the user can switch back without a cold
start. (This is cheap and harmless — the weighted picker ignores those fields.)

### Picking the next card (weighted-random mode)

1. Build a weights array over all words: `w_i = weight(srsState_i)`.
2. Pick index `i` with probability `w_i / Σ w`.
3. Avoid immediate repeats: if the picked word equals the previously shown
   word and the deck has >1 word, pick again (cap retries at 5).

## Serial (`lib/srs/serial.ts`)

A non-adaptive mode for "walk the deck end to end." Useful for first-pass
familiarisation or when the user wants predictable order. There's no
randomness, no scheduling, and grades have no effect on which word comes
next — they're still recorded so SM-2 state continues to accumulate.

### Ordering

Serial order is **`id` ascending, numerically**. Since `id` is the
creation epoch-ms (`Date.now().toString()`), this is identical to "oldest
word first." It's stable because ids never change and identical ids don't
occur on a single client.

`serial.ts` exposes a single `compareWords(a, b): number` helper used by
the picker:

```ts
const compareWords = (a: Word, b: Word) => Number(a.id) - Number(b.id);
```

No separate sort-key field on `Word`, no auxiliary order topic — the id is
already the order.

### Position tracking

Serial mode needs a "where am I in the list" cursor. v1 keeps this in
**memory only** (a property on the serial module's reactive store). Trade-off:

- ✅ No extra MQTT topic, no extra schema field, no cross-device race.
- ❌ Refreshing the page or switching devices restarts from the beginning.

A later iteration can persist the cursor — either as a field on `Settings`
(`lastSerialId: string | null`) or in a separate ephemeral topic. The
algorithm itself doesn't change; only where the cursor is stored.

### Transition

Same as weighted random — apply the SM-2 update so history accumulates,
but the picker ignores schedule fields:

```
srsState.lastGrade      = grade
srsState.lastReviewedAt = now
srsState.reviewCount   += 1
// plus SM-2 ease/interval/due update, for history continuity
```

### Picking the next card (serial mode)

1. Sort `words` with `compareWords`. Call the result `ordered`.
2. If `ordered` is empty, return `null`.
3. Let `i = ordered.findIndex(w => w.id === previousId)`.
   - If `previousId` is unset or not found → return `ordered[0]`.
   - Else → return `ordered[(i + 1) % ordered.length]` (wrap around).
4. The deck-wrap behaviour is "loop forever" in v1. Showing an
   "end of deck" screen after one full pass is a possible later refinement.

## The dispatcher (`lib/srs/picker.ts`)

```ts
type PickArgs = {
  words: Word[];
  srs: Map<string, SrsState>;
  settings: Settings;
  now: Date;
  previousId?: string;
};

export function pickNext(args: PickArgs): Word | null {
  switch (args.settings.srsMode) {
    case 'weighted-random': return weighted.pick(args);
    case 'serial':          return serial.pick(args);
    case 'sm2':
    default:                return sm2.pick(args);
  }
}

export function applyGrade(state: SrsState, grade: Grade, now: Date): SrsState {
  // Always apply SM-2 transition — all three modes write the same fields,
  // weighted and serial just ignore the schedule fields when picking.
  return sm2.transition(state, grade, now);
}
```

This keeps the UI mode-agnostic: it calls `pickNext` and `applyGrade`,
the dispatcher does the rest.

## Testing

`tests/sm2.test.ts` should cover:

- A new card graded `good` → `interval=1, reps=1`.
- The same card graded `good` again → `interval=6, reps=2`.
- A third `good` → `interval = round(6 * ease)`.
- `again` resets reps and lapses += 1, leaves ease above 1.3.
- `hard` shrinks ease, `easy` grows it; ease is clamped at 1.3.
- `due` advances by exactly `intervalDays` from `now`.

`tests/weighted.test.ts` should cover:

- Weight values match the spec for each grade.
- With seeded RNG, picks distribute roughly proportional to weights over many trials.
- Immediate-repeat avoidance kicks in when the deck has >1 word.

`tests/serial.test.ts` should cover:

- Empty deck returns `null`.
- No `previousId` → returns first word in `compareWords` order.
- `previousId` somewhere in the middle → returns the next one.
- `previousId` is the last word → wraps to the first.
- `previousId` not present in the deck (e.g. just deleted) → returns first.
- Order is stable across calls with the same input.

Both modules are pure functions — no mocks, no MQTT, no DOM. Time is always
injected (`now: Date`), randomness is injected for the weighted picker
(`rng: () => number`, defaulting to `Math.random`).

## Possible future tweaks

- **Learning steps** (Anki-style 1m/10m before graduating to days).
- **Leech detection** — auto-tag cards with too many lapses.
- **FSRS** as a fourth mode (see "Why not FSRS" above).
- **Daily new-card limit** to prevent dumping 200 new cards into one session.
- **Persist the serial cursor** across reloads / devices.

None of these require schema changes beyond adding new fields to `SrsState`
and one new value to `SrsMode`.
