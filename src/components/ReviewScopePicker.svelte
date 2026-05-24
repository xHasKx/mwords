<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import type { ReviewScope } from '../lib/types.ts';

  // Multi-select sheet state. When `sheetOpen` is true the bottom sheet
  // is visible and the user is editing a pending selection. `pending`
  // is the staged set of deck ids; it's only committed via
  // setReviewScope when the user taps Done.
  let sheetOpen = $state(false);
  let pending = $state<Set<string>>(new Set());

  const sortedDecks = $derived(
    Array.from(app.decks.values()).sort((a, b) => Number(a.id) - Number(b.id)),
  );

  function setScope(scope: ReviewScope) {
    app.setReviewScope(scope);
  }

  function pickJustThisDeck() {
    if (app.activeDeckId === null) return;
    setScope({ kind: 'active-deck' });
  }

  function pickAllDecks() {
    setScope({ kind: 'group' });
  }

  function openSheet() {
    // Pre-fill the pending selection from a reasonable seed:
    //   - 'decks' scope → its deckIds
    //   - 'active-deck' scope → just the active deck (if any)
    //   - 'group' scope → all decks
    const seed = new Set<string>();
    const scope = app.reviewScope;
    if (scope.kind === 'decks') {
      for (const d of scope.deckIds) if (app.decks.has(d)) seed.add(d);
    } else if (scope.kind === 'active-deck') {
      if (app.activeDeckId) seed.add(app.activeDeckId);
    } else {
      for (const d of app.decks.keys()) seed.add(d);
    }
    pending = seed;
    sheetOpen = true;
  }

  function toggle(id: string) {
    const next = new Set(pending);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    pending = next;
  }

  function applySheet() {
    if (pending.size === 0) {
      // setReviewScope folds an empty deckIds list back to active-deck.
      // Closing the sheet without a selection is a no-op in scope terms.
      sheetOpen = false;
      return;
    }
    setScope({ kind: 'decks', deckIds: Array.from(pending) });
    sheetOpen = false;
  }

  function cancelSheet() {
    sheetOpen = false;
  }
</script>

<div class="scope-picker" role="group" aria-label="Review scope">
  <button
    type="button"
    class="opt"
    class:active={app.reviewScope.kind === 'active-deck'}
    aria-pressed={app.reviewScope.kind === 'active-deck'}
    disabled={app.activeDeckId === null}
    onclick={pickJustThisDeck}
    title={app.activeDeckId === null ? 'Pick a deck first (Switch deck below)' : undefined}
  >Just this deck</button>
  <button
    type="button"
    class="opt"
    class:active={app.reviewScope.kind === 'decks'}
    aria-pressed={app.reviewScope.kind === 'decks'}
    onclick={openSheet}
  >Selected decks{app.reviewScope.kind === 'decks' ? ` (${app.reviewScope.deckIds.length})` : ''}</button>
  <button
    type="button"
    class="opt"
    class:active={app.reviewScope.kind === 'group'}
    aria-pressed={app.reviewScope.kind === 'group'}
    onclick={pickAllDecks}
  >All decks</button>
</div>

{#if sheetOpen}
  <div class="sheet-backdrop" role="presentation" onclick={cancelSheet} onkeydown={null}></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Pick decks to review">
    <div class="sheet-head">
      <h2>Pick decks to review</h2>
    </div>
    <ul class="deck-list">
      {#each sortedDecks as d (d.id)}
        <li>
          <label class="row">
            <input
              type="checkbox"
              checked={pending.has(d.id)}
              onchange={() => toggle(d.id)}
            />
            <span class="name">{d.name}</span>
            <span class="count muted">
              {(() => {
                const n = app.wordCountInDeck(d.id);
                return `${n} word${n === 1 ? '' : 's'}`;
              })()}
            </span>
          </label>
        </li>
      {/each}
    </ul>
    <div class="sheet-actions">
      <button type="button" onclick={cancelSheet}>Cancel</button>
      <button
        type="button"
        class="primary"
        onclick={applySheet}
        disabled={pending.size === 0}
      >Done ({pending.size})</button>
    </div>
  </div>
{/if}

<style>
  .scope-picker {
    display: flex;
    gap: 0.25rem;
    background: var(--bg-2);
    border-radius: 8px;
    padding: 0.25rem;
  }
  .opt {
    flex: 1;
    min-height: 36px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--fg-2);
    font-size: 0.85rem;
    padding: 0.35rem 0.5rem;
  }
  .opt.active {
    background: var(--accent);
    color: white;
  }
  .opt:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 60;
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 61;
    background: var(--bg-2);
    border-top: 1px solid var(--border);
    border-radius: 12px 12px 0 0;
    padding: 0.75rem 1rem;
    padding-bottom: calc(0.75rem + var(--safe-bottom));
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .sheet-head h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .deck-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.5rem 0.25rem;
    border-radius: 6px;
    cursor: pointer;
  }
  .row:hover {
    background: var(--bg-3);
  }
  .row input[type='checkbox'] {
    width: 18px;
    height: 18px;
    margin: 0;
  }
  .name {
    flex: 1;
    font-size: 1rem;
  }
  .count {
    font-size: 0.8rem;
  }
  .sheet-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .sheet-actions button {
    min-width: 96px;
  }
</style>
