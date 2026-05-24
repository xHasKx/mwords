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

  function cancel() {
    app.disconnect();
  }

  // Tick once a second while a reconnect countdown is showing.
  let nowTick = $state(Date.now());
  $effect(() => {
    if (app.connection !== 'reconnecting' || app.nextAttemptAt === null) return;
    nowTick = Date.now();
    const id = setInterval(() => (nowTick = Date.now()), 1000);
    return () => clearInterval(id);
  });

  const inFlight = $derived(
    app.connection === 'connecting' || app.connection === 'reconnecting',
  );

  const statusText = $derived.by(() => {
    if (app.connection === 'reconnecting') {
      if (app.nextAttemptAt !== null) {
        const secs = Math.max(0, Math.ceil((app.nextAttemptAt - nowTick) / 1000));
        return `Reconnecting in ${secs}s…`;
      }
      return 'Reconnecting…';
    }
    if (app.connection === 'connecting') return 'Connecting…';
    return null;
  });
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
  {#if !inFlight && app.connectionError}
    <div class="error" role="status">{app.connectionError}</div>
  {/if}
  {#if inFlight}
    <button type="button" class="danger" onclick={cancel}>Cancel</button>
    {#if statusText}
      <div class="status" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <span>{statusText}</span>
      </div>
    {/if}
  {:else}
    <button type="submit" class="primary">Save &amp; connect</button>
  {/if}
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
  .status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: var(--fg-2);
  }
  .spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
  }
</style>
