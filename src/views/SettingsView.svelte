<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import type { Direction } from '../lib/types.ts';

  async function setDirection(d: Direction) {
    await app.updateSettings({ direction: d });
  }

  function disconnect() {
    app.disconnect();
  }

  function disconnectAndForget() {
    if (!confirm('Disconnect and forget stored credentials?')) return;
    app.disconnectAndForget();
  }
</script>

<div class="col">
  <h1>Settings</h1>

  <div class="card col">
    <div><strong>SRS mode</strong></div>
    <div class="muted">Only <code>sm2</code> is available in this build. Weighted and Serial modes ship in slice 3.</div>
  </div>

  <div class="card col">
    <div><strong>Direction</strong></div>
    <div class="row" role="radiogroup">
      <button
        class={app.settings.direction === 'text' ? 'primary' : ''}
        onclick={() => setDirection('text')}>Show text first</button>
      <button
        class={app.settings.direction === 'translation' ? 'primary' : ''}
        onclick={() => setDirection('translation')}>Show translation first</button>
    </div>
  </div>

  <div class="card col">
    <div><strong>Connection</strong></div>
    <div class="muted">Disconnect returns to the connect form with credentials kept; forget also wipes them from local storage.</div>
    <div class="row buttons">
      <button onclick={disconnect}>Disconnect</button>
      <button class="danger" onclick={disconnectAndForget}>Disconnect &amp; forget</button>
    </div>
  </div>
</div>
