<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import { isValidPrefix } from '../lib/mqtt/topics.ts';
  import { queue } from '../lib/mqtt/queue.ts';
  import { queueStore } from '../lib/stores/queue.svelte.ts';

  let url = $state('');
  let username = $state('');
  let password = $state('');
  let prefix = $state('mwords');
  let autoconnect = $state(false);
  let error = $state<string | null>(null);

  const stored = app.storedConnection();
  if (stored) {
    url = stored.url;
    username = stored.username;
    password = stored.password;
    prefix = stored.prefix;
    autoconnect = stored.autoconnect === true;
  }

  function submit(e: Event) {
    e.preventDefault();
    error = null;
    if (!url.trim()) return (error = 'URL required');
    if (!prefix.trim()) return (error = 'Prefix required');
    if (!isValidPrefix(prefix)) return (error = 'Prefix may not contain / + # whitespace or null');
    app.connect({
      url: url.trim(),
      username: username.trim(),
      password,
      prefix: prefix.trim(),
      autoconnect,
    });
  }

  function clearPending() {
    const count = queueStore.pendingCount;
    if (count === 0) return;
    if (!confirm(`Discard ${count} pending change${count === 1 ? '' : 's'}? They will not be sent to the broker.`)) return;
    void queue.clear();
  }
</script>

<form class="col" onsubmit={submit}>
  <h1>Connect</h1>
  <div>
    <label for="url">WebSocket URL</label>
    <input id="url" type="url" bind:value={url} placeholder="wss://broker.example.com:8884/mqtt" />
  </div>
  <div>
    <label for="user">Username</label>
    <input id="user" bind:value={username} autocomplete="username" />
  </div>
  <div>
    <label for="pw">Password</label>
    <input id="pw" type="password" bind:value={password} autocomplete="current-password" />
  </div>
  <div>
    <label for="pfx">Prefix</label>
    <input id="pfx" bind:value={prefix} />
  </div>
  <label class="check">
    <input id="autoconnect" type="checkbox" bind:checked={autoconnect} />
    <span>Autoconnect on page load</span>
  </label>
  {#if error}<div class="error">{error}</div>{/if}
  <button type="submit" class="primary">Save &amp; connect</button>
  {#if queueStore.pendingCount > 0}
    <button type="button" class="danger" onclick={clearPending}>
      Clear pending queue ({queueStore.pendingCount})
    </button>
  {/if}
</form>

<style>
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
    cursor: pointer;
  }
  .check input[type='checkbox'] {
    width: auto;
    margin: 0;
  }
</style>
