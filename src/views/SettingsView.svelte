<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import type { Direction, SrsMode } from '../lib/types.ts';

  const modes: { value: SrsMode; label: string; hint: string }[] = [
    { value: 'sm2', label: 'SM-2', hint: 'Classic spaced-repetition with due dates.' },
    { value: 'weighted-random', label: 'Weighted random', hint: 'Always pick; bias toward recent Agains.' },
    { value: 'serial', label: 'Serial', hint: 'Walk the deck in stable list order.' },
  ];

  async function setMode(m: SrsMode) {
    await app.updateSettings({ srsMode: m });
  }

  async function setDirection(d: Direction) {
    await app.updateSettings({ direction: d });
  }

  function disconnect() {
    app.disconnect();
  }

  function disconnectAndForget() {
    if (!confirm('Disconnect and forget stored credentials?')) return;
    void app.disconnectAndForget();
  }
</script>

<div class="col">
  <h1>Settings</h1>

  <div class="card col">
    <div><strong>SRS mode</strong></div>
    <div class="col" role="radiogroup">
      {#each modes as m (m.value)}
        <button
          class={app.settings.srsMode === m.value ? 'primary' : ''}
          onclick={() => setMode(m.value)}>
          <div class="mode-label">{m.label}</div>
          <div class="mode-hint">{m.hint}</div>
        </button>
      {/each}
    </div>
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

<style>
  .mode-label { font-weight: 500; }
  .mode-hint { font-size: 0.85rem; opacity: 0.8; margin-top: 0.15rem; }
  [role='radiogroup'] button {
    text-align: left;
    padding: 0.6rem 0.85rem;
  }
</style>
