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

  async function remove(id: string, name: string) {
    if (!confirm(`Delete group "${name}"? All its words and review history will be removed. This cannot be undone.`)) return;
    busy = true;
    try {
      await app.deleteGroup(id);
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
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

  let portStatus = $state<string | null>(null);
  let portError = $state<string | null>(null);
  let fileInput: HTMLInputElement | null = $state(null);

  const canPort = $derived(app.connection === 'connected');
  const portHint = $derived(canPort ? undefined : 'Connect to the broker to import or export.');

  async function doExport() {
    portError = null;
    portStatus = 'Exporting…';
    busy = true;
    try {
      const r = await app.exportAll();
      portStatus = `Saved as ${r.filename} (${r.groupCount} group${r.groupCount === 1 ? '' : 's'}, ${r.wordCount} word${r.wordCount === 1 ? '' : 's'}).`;
    } catch (err) {
      portStatus = null;
      portError = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function pickImportFile() {
    portError = null;
    portStatus = null;
    fileInput?.click();
  }

  async function onImportFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Reset so re-selecting the same file fires `change` again.
    input.value = '';
    if (!file) return;
    portError = null;
    portStatus = 'Importing…';
    busy = true;
    try {
      const text = await file.text();
      const r = await app.importAll(text);
      portStatus = `Imported ${r.groupCount} new group${r.groupCount === 1 ? '' : 's'} and ${r.wordCount} word${r.wordCount === 1 ? '' : 's'}.`;
    } catch (err) {
      portStatus = null;
      portError = (err as Error).message;
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
                aria-current={app.activeGroupId === g.id ? 'true' : undefined}
              >
                <span class="name" class:current={app.activeGroupId === g.id}>{g.name}</span>
              </button>
              <button
                class="edit"
                onclick={() => startRename(g.id, g.name)}
                disabled={busy}
                aria-label="Rename group"
                title="Rename"
              >✎</button>
              <button
                class="delete"
                onclick={() => remove(g.id, g.name)}
                disabled={busy}
                aria-label="Delete group"
                title="Delete"
              >✖</button>
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

  <div class="card col port">
    <div><strong>Import / Export</strong></div>
    <div class="muted port-hint">
      Export your groups and words to a JSON file, or import a file from another mwords instance. Imports merge into existing groups by name; SRS history is not preserved.
    </div>
    <div class="row">
      <button onclick={doExport} disabled={busy || !canPort} title={portHint}>
        Export to file
      </button>
      <button onclick={pickImportFile} disabled={busy || !canPort} title={portHint}>
        Import from file
      </button>
    </div>
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,application/json"
      onchange={onImportFile}
      hidden
    />
    {#if portStatus}<div class="muted" role="status">{portStatus}</div>{/if}
    {#if portError}<div class="error">{portError}</div>{/if}
  </div>
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
  .group-row .edit,
  .group-row .delete {
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
    border-radius: 0;
    width: 48px;
    font-size: 1.05rem;
  }
  .group-row .edit { color: var(--fg-2); }
  .group-row .delete { color: var(--danger); }
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
  .port { margin-top: 0.5rem; }
  .port-hint { font-size: 0.85rem; }
</style>
