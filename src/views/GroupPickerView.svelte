<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';

  let newName = $state('');
  let createError = $state<string | null>(null);
  let busy = $state(false);

  let editingId = $state<string | null>(null);
  let editingName = $state('');
  let editError = $state<string | null>(null);
  let renameInput: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (editingId !== null && renameInput) renameInput.focus();
  });

  async function create(e: Event) {
    e.preventDefault();
    createError = null;
    busy = true;
    try {
      await app.createGroup(newName);
      newName = '';
    } catch (err) {
      createError = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function pick(id: string) {
    if (editingId === id) return;
    busy = true;
    try {
      await app.selectGroup(id);
    } finally {
      busy = false;
    }
  }

  function startRename(id: string, currentName: string) {
    editingId = id;
    editingName = currentName;
    editError = null;
  }

  function cancelRename() {
    editingId = null;
    editingName = '';
    editError = null;
  }

  async function submitRename(e: Event) {
    e.preventDefault();
    if (!editingId) return;
    editError = null;
    busy = true;
    try {
      await app.renameGroup(editingId, editingName);
      cancelRename();
    } catch (err) {
      editError = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  const sortedGroups = $derived(
    Array.from(app.groups.values()).sort((a, b) => Number(a.id) - Number(b.id)),
  );
</script>

<div class="col">
  <div class="head">
    {#if app.pickerReturn !== null}
      <button class="back" onclick={() => app.cancelSwitchGroup()} aria-label="Back" title="Back">←</button>
    {/if}
    <h1>Pick a group</h1>
  </div>

  {#if sortedGroups.length === 0}
    <p class="muted">No groups yet. Create one below.</p>
  {:else}
    <ul class="groups">
      {#each sortedGroups as g (g.id)}
        <li>
          {#if editingId === g.id}
            <form class="rename-row" onsubmit={submitRename}>
              <input
                bind:this={renameInput}
                bind:value={editingName}
                aria-label="Group name"
                disabled={busy}
              />
              <button
                type="submit"
                class="primary"
                disabled={busy || !editingName.trim()}
              >Save</button>
              <button type="button" onclick={cancelRename} disabled={busy}>Cancel</button>
            </form>
            {#if editError}<div class="error">{editError}</div>{/if}
          {:else}
            <div class="group-row">
              <button
                class="select"
                onclick={() => pick(g.id)}
                disabled={busy}
              >
                <span class="name">{g.name}</span>
              </button>
              <button
                class="edit"
                onclick={() => startRename(g.id, g.name)}
                disabled={busy}
                aria-label="Rename group"
                title="Rename"
              >✎</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <form class="col create" onsubmit={create}>
    <label for="newname">Create new group</label>
    <div class="row">
      <input id="newname" bind:value={newName} placeholder="e.g. German A1" />
      <button type="submit" class="primary" disabled={busy || !newName.trim()}>Create</button>
    </div>
    {#if createError}<div class="error">{createError}</div>{/if}
  </form>
</div>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .head h1 { margin: 0; }
  .back {
    background: transparent;
    border: none;
    width: 40px;
    height: 40px;
    min-height: 40px;
    padding: 0;
    font-size: 1.25rem;
    color: var(--fg-2);
  }
  .groups { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .group-row {
    display: flex;
    align-items: stretch;
    background: var(--bg-2);
    border-radius: 8px;
    overflow: hidden;
  }
  .group-row .select {
    flex: 1;
    text-align: left;
    padding: 0.85rem 1rem;
    background: transparent;
    border: none;
    border-radius: 0;
  }
  .group-row .edit {
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
    border-radius: 0;
    width: 48px;
    color: var(--fg-2);
    font-size: 1.05rem;
  }
  .name { font-size: 1.05rem; }
  .rename-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .rename-row input { flex: 1; }
  .create { margin-top: 1rem; }
  .row { gap: 0.5rem; }
  .row input { flex: 1; }
</style>
