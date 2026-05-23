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

  const incoming = app.shareImport;
  const stored = app.storedConnection();
  if (incoming) {
    // Share-link path: pre-fill from the URL payload. Don't carry over
    // autoconnect from the sender — the receiver opts in deliberately.
    url = incoming.url;
    username = incoming.username;
    password = incoming.password;
    prefix = incoming.prefix;
    autoconnect = false;
  } else if (stored) {
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
  {#if incoming}
    <div class="note" role="status">
      Connection details pre-filled from a share link. Review and click <strong>Save &amp; connect</strong> to use them.
    </div>
  {/if}
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
  .note {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
    padding: 0.6rem 0.85rem;
    font-size: 0.9rem;
    color: var(--fg-2);
  }
</style>
