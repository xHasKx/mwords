<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '../lib/stores/app.svelte.ts';

  let newName = $state('');
  let createError = $state<string | null>(null);
  let busy = $state(false);

  let editingName = $state('');
  let editError = $state<string | null>(null);
  let renameInput: HTMLInputElement | null = $state(null);

  // Multi-select mode: when true, rows show checkboxes and a sticky
  // "Review selected (N)" CTA sits at the bottom. Tapping a row in
  // this mode toggles its inclusion rather than activating it. Local
  // to this view — no persistence.
  let multi = $state(false);
  let selected = $state<Set<string>>(new Set());

  function toggleMulti() {
    multi = !multi;
    if (!multi) selected = new Set();
  }

  function toggleSelected(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  const renamingId = $derived(
    app.modal?.kind === 'rename-deck' ? app.modal.deckId : null,
  );

  $effect(() => {
    const id = renamingId;
    if (id === null) return;
    untrack(() => {
      const d = app.decks.get(id);
      editingName = d?.name ?? '';
      editError = null;
    });
    queueMicrotask(() => renameInput?.focus());
  });

  async function create(e: Event) {
    e.preventDefault();
    createError = null;
    busy = true;
    try {
      const id = await app.createDeck(newName);
      newName = '';
      // Newly-created deck becomes the active one; advance to the
      // caller's pickerReturn (or Review).
      app.selectDeck(id);
    } catch (err) {
      createError = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function pick(id: string) {
    if (renamingId === id) return;
    if (multi) {
      toggleSelected(id);
      return;
    }
    app.selectDeck(id);
  }

  function pickAllDecks() {
    app.selectScopeAndReview({ kind: 'group' });
  }

  function reviewSelected() {
    if (selected.size === 0) return;
    app.selectScopeAndReview({ kind: 'decks', deckIds: Array.from(selected) });
  }

  async function remove(id: string, name: string) {
    if (
      !confirm(
        `Delete deck "${name}"? All its words and review history will be removed. This cannot be undone.`,
      )
    )
      return;
    busy = true;
    try {
      await app.deleteDeck(id);
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }

  function startRename(id: string) {
    app.openRenameDeck(id);
  }

  function cancelRename() {
    app.goBack();
  }

  async function submitRename(e: Event) {
    e.preventDefault();
    const id = renamingId;
    if (id === null) return;
    editError = null;
    busy = true;
    try {
      await app.renameDeck(id, editingName);
      app.goBack();
    } catch (err) {
      editError = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  const groupName = $derived(
    app.activeGroupId ? (app.groups.get(app.activeGroupId)?.name ?? '') : '',
  );

  const sortedDecks = $derived(
    Array.from(app.decks.values()).sort((a, b) => Number(a.id) - Number(b.id)),
  );
</script>

<div class="col">
  <div class="head">
    <button
      class="up"
      onclick={() => app.openGroupPickerFromDeckPicker()}
      aria-label="Switch group"
      title="Switch group"
    >↑</button>
    <h1>
      <span class="group muted">{groupName}</span>
      <span class="sep muted">›</span>
      <span>Pick a deck</span>
    </h1>
    <button
      class="multi-toggle"
      class:active={multi}
      onclick={toggleMulti}
      aria-pressed={multi}
      disabled={busy}
    >{multi ? 'Done' : 'Select multiple'}</button>
  </div>

  {#if !multi}
    <button
      class="all-row primary"
      onclick={pickAllDecks}
      disabled={busy || sortedDecks.length === 0}
    >
      <span>All decks (review)</span>
      <span class="muted small">
        {sortedDecks.length === 0 ? 'no decks' : `${app.words.size} word${app.words.size === 1 ? '' : 's'}`}
      </span>
    </button>
  {/if}

  {#if sortedDecks.length === 0}
    <p class="muted">No decks yet. Create one below.</p>
  {:else}
    <ul class="decks">
      {#each sortedDecks as d (d.id)}
        <li>
          {#if renamingId === d.id}
            <form class="rename-row" onsubmit={submitRename}>
              <input
                bind:this={renameInput}
                bind:value={editingName}
                aria-label="Deck name"
                disabled={busy}
              />
              <button type="submit" class="primary" disabled={busy || !editingName.trim()}>Save</button>
              <button type="button" onclick={cancelRename} disabled={busy}>Cancel</button>
            </form>
            {#if editError}<div class="error">{editError}</div>{/if}
          {:else}
            <div class="deck-row" class:current={app.activeDeckId === d.id}>
              {#if multi}
                <label class="check-wrap">
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onchange={() => toggleSelected(d.id)}
                    disabled={busy}
                    aria-label={`Include ${d.name}`}
                  />
                </label>
              {/if}
              <button
                class="select"
                onclick={() => pick(d.id)}
                disabled={busy}
                aria-current={app.activeDeckId === d.id ? 'true' : undefined}
              >
                <span class="name" class:current={app.activeDeckId === d.id}>{d.name}</span>
                <span class="count muted small">
                  {(() => {
                    const n = app.wordCountInDeck(d.id);
                    return `${n} word${n === 1 ? '' : 's'}`;
                  })()}
                </span>
              </button>
              {#if !multi}
                <button
                  class="edit"
                  onclick={() => startRename(d.id)}
                  disabled={busy}
                  aria-label="Rename deck"
                  title="Rename"
                >✎</button>
                <button
                  class="delete"
                  onclick={() => remove(d.id, d.name)}
                  disabled={busy}
                  aria-label="Delete deck"
                  title="Delete"
                >✖</button>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if !multi}
    <form class="col create" onsubmit={create}>
      <label for="newdeckname">Create new deck</label>
      <div class="row">
        <input id="newdeckname" bind:value={newName} placeholder="e.g. A1 Verbs" />
        <button type="submit" class="primary" disabled={busy || !newName.trim()}>Create</button>
      </div>
      {#if createError}<div class="error">{createError}</div>{/if}
    </form>
  {/if}
</div>

{#if multi}
  <div class="multi-cta">
    <button
      class="primary"
      onclick={reviewSelected}
      disabled={busy || selected.size === 0}
    >Review selected ({selected.size})</button>
  </div>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .head h1 {
    margin: 0;
    flex: 1;
    font-size: 1.15rem;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    overflow: hidden;
  }
  .head h1 .group,
  .head h1 .sep {
    font-size: 0.95rem;
    font-weight: 500;
  }
  .head h1 .group {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
  }
  .up {
    background: transparent;
    border: none;
    width: 40px;
    height: 40px;
    min-height: 40px;
    padding: 0;
    font-size: 1.3rem;
    color: var(--fg-2);
  }
  .multi-toggle {
    font-size: 0.85rem;
    padding: 0.35rem 0.6rem;
    min-height: 36px;
  }
  .multi-toggle.active {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .all-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    text-align: left;
    padding: 0.85rem 1rem;
  }
  .all-row .small { font-size: 0.85rem; }
  .decks { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .deck-row {
    display: flex;
    align-items: stretch;
    background: var(--bg-2);
    border-radius: 8px;
    overflow: hidden;
    border: 2px solid transparent;
  }
  .deck-row.current { border-color: var(--accent); }
  .deck-row .select {
    flex: 1;
    text-align: left;
    padding: 0.85rem 1rem;
    background: transparent;
    border: none;
    border-radius: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
  }
  .deck-row .count {
    font-size: 0.8rem;
  }
  .small { font-size: 0.85rem; }
  .deck-row .edit,
  .deck-row .delete {
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
    border-radius: 0;
    width: 48px;
    font-size: 1.05rem;
  }
  .deck-row .edit { color: var(--fg-2); }
  .deck-row .delete { color: var(--danger); }
  .check-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.75rem;
    border-right: 1px solid var(--border);
  }
  .check-wrap input { width: 18px; height: 18px; margin: 0; }
  .name { font-size: 1.05rem; }
  .name.current { font-weight: 700; }
  .rename-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .rename-row input { flex: 1; }
  .create { margin-top: 1rem; }
  .row { gap: 0.5rem; }
  .row input { flex: 1; }
  .multi-cta {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(72px + var(--safe-bottom));
    padding: 0.75rem 1rem;
    background: var(--bg-2);
    border-top: 1px solid var(--border);
    z-index: 20;
  }
  .multi-cta button { width: 100%; }
</style>
