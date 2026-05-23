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

  <fieldset class="card col">
    <legend><strong>SRS mode</strong></legend>
    <div class="col">
      {#each modes as m (m.value)}
        <button
          class={app.settings.srsMode === m.value ? 'primary' : ''}
          aria-pressed={app.settings.srsMode === m.value}
          onclick={() => setMode(m.value)}>
          <div class="mode-label">{m.label}</div>
          <div class="mode-hint">{m.hint}</div>
        </button>
      {/each}
    </div>
  </fieldset>

  <fieldset class="card col">
    <legend><strong>Direction</strong></legend>
    <div class="row">
      <button
        class={app.settings.direction === 'text' ? 'primary' : ''}
        aria-pressed={app.settings.direction === 'text'}
        onclick={() => setDirection('text')}>Show text first</button>
      <button
        class={app.settings.direction === 'translation' ? 'primary' : ''}
        aria-pressed={app.settings.direction === 'translation'}
        onclick={() => setDirection('translation')}>Show translation first</button>
    </div>
  </fieldset>

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
  fieldset {
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  fieldset legend {
    padding: 0 0.4rem;
    font-weight: normal;
  }
  fieldset button {
    text-align: left;
    padding: 0.6rem 0.85rem;
  }
</style>
