<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import { isValidPrefix } from '../lib/mqtt/topics.ts';

  let url = $state('wss://mqtt.flespi.io');
  let username = $state('');
  let password = $state('');
  let prefix = $state('mwords');
  let error = $state<string | null>(null);

  const stored = app.storedConnection();
  if (stored) {
    url = stored.url;
    username = stored.username;
    password = stored.password;
    prefix = stored.prefix;
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
    });
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
  {#if error}<div class="error">{error}</div>{/if}
  <button type="submit" class="primary">Save &amp; connect</button>
</form>
