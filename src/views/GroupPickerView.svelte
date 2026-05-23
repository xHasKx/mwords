<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';

  let newName = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function create(e: Event) {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      await app.createGroup(newName);
      newName = '';
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function pick(id: string) {
    busy = true;
    try {
      await app.selectGroup(id);
    } finally {
      busy = false;
    }
  }

  const sortedGroups = $derived(
    Array.from(app.groups.values()).sort((a, b) => Number(a.id) - Number(b.id)),
  );
</script>

<div class="col">
  <h1>Pick a group</h1>

  {#if sortedGroups.length === 0}
    <p class="muted">No groups yet. Create one below.</p>
  {:else}
    <ul class="groups">
      {#each sortedGroups as g (g.id)}
        <li>
          <button class="group-row" onclick={() => pick(g.id)} disabled={busy}>
            <span class="name">{g.name}</span>
          </button>
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
    {#if error}<div class="error">{error}</div>{/if}
  </form>
</div>

<style>
  .groups { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .group-row {
    display: block;
    text-align: left;
    width: 100%;
    padding: 0.85rem 1rem;
    background: var(--bg-2);
  }
  .name { font-size: 1.05rem; }
  .create { margin-top: 1rem; }
  .row { gap: 0.5rem; }
  .row input { flex: 1; }
</style>
