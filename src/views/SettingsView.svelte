<script lang="ts">
  import { Browser } from '@capacitor/browser';
  import { Capacitor } from '@capacitor/core';
  import { app } from '../lib/stores/app.svelte.ts';
  import { DEFAULT_REPEAT_HOURS, type Direction, type SrsMode } from '../lib/types.ts';

  const SOURCE_URL = 'https://github.com/xHasKx/mwords';

  const modes: { value: SrsMode; label: string; hint: string }[] = [
    { value: 'sm2', label: 'SM-2', hint: 'Classic spaced-repetition with due dates.' },
    { value: 'weighted-random', label: 'Weighted random', hint: 'Always pick; bias toward recent Agains.' },
    { value: 'serial', label: 'Serial', hint: 'Walk the deck in stable list order.' },
  ];

  let shareUrl = $state<string | null>(null);
  let shareStatus = $state<'idle' | 'copied' | 'manual'>('idle');
  let shareStatusTimer: number | null = null;

  // Repeat-interval input. Local draft state so the user can type
  // freely without each keystroke publishing to the broker; commit on
  // blur or Enter (or via the inline Save button if the value parses).
  let repeatHoursDraft = $state(String(app.settings.repeatHours ?? DEFAULT_REPEAT_HOURS));
  // Re-seed the draft whenever the source value changes from elsewhere
  // (initial sync, peer update). The string comparison avoids stomping
  // the user's mid-edit value when their own publish round-trips.
  $effect(() => {
    const current = String(app.settings.repeatHours ?? DEFAULT_REPEAT_HOURS);
    if (current !== repeatHoursDraft && document.activeElement?.id !== 'repeat-hours') {
      repeatHoursDraft = current;
    }
  });
  let repeatHoursError = $state<string | null>(null);

  async function setMode(m: SrsMode) {
    await app.updateSettings({ srsMode: m });
  }

  async function setDirection(d: Direction) {
    await app.updateSettings({ direction: d });
  }

  async function commitRepeatHours() {
    const n = Number(repeatHoursDraft);
    if (!Number.isInteger(n) || n < 1) {
      repeatHoursError = 'Whole number of hours, 1 or more.';
      return;
    }
    repeatHoursError = null;
    if (n === (app.settings.repeatHours ?? DEFAULT_REPEAT_HOURS)) return;
    await app.updateSettings({ repeatHours: n });
  }

  function disconnect() {
    app.disconnect();
  }

  function disconnectAndForget() {
    if (!confirm('Disconnect and forget stored credentials?')) return;
    void app.disconnectAndForget();
  }

  async function openSource(e: Event) {
    // On native Capacitor, the WebView would otherwise try to navigate
    // itself to GitHub (we'd lose the app). Browser.open routes through
    // Chrome Custom Tabs on Android / SFSafariViewController on iOS.
    if (Capacitor.isNativePlatform()) {
      e.preventDefault();
      await Browser.open({ url: SOURCE_URL });
    }
    // In the regular browser, let the anchor's default target=_blank
    // behavior take over.
  }

  async function shareConnection() {
    const url = app.buildShareUrl();
    if (!url) return;
    shareUrl = url;
    if (shareStatusTimer !== null) clearTimeout(shareStatusTimer);
    try {
      await navigator.clipboard.writeText(url);
      shareStatus = 'copied';
      shareStatusTimer = window.setTimeout(() => {
        shareStatus = 'idle';
        shareUrl = null;
      }, 2500);
    } catch {
      // Clipboard unavailable (insecure origin, permission denied) —
      // surface the URL so the user can copy it manually.
      shareStatus = 'manual';
    }
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
    <legend><strong>Repeat interval</strong></legend>
    <div class="muted hint">
      Hours between repeats of a graded card. Default 24 (one day). Lower values shorten every SM-2 interval; the scheduling logic is otherwise unchanged.
    </div>
    <div class="row">
      <input
        id="repeat-hours"
        type="number"
        inputmode="numeric"
        min="1"
        step="1"
        bind:value={repeatHoursDraft}
        onblur={commitRepeatHours}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRepeatHours(); } }}
      />
      <span class="muted">hours</span>
    </div>
    {#if repeatHoursError}
      <div class="error">{repeatHoursError}</div>
    {/if}
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
    <div class="muted share-hint">
      Share a link that pre-fills broker URL, prefix, and credentials on another device. Credentials are base64-encoded — not encrypted — so only share with people you trust.
    </div>
    <div class="row">
      <button onclick={shareConnection}>Copy share link</button>
      {#if shareStatus === 'copied'}
        <span class="muted" role="status">Copied!</span>
      {/if}
    </div>
    {#if shareStatus === 'manual' && shareUrl}
      <div class="muted">Couldn't access the clipboard. Copy the URL manually:</div>
      <input class="manual-share" type="text" readonly value={shareUrl} aria-label="Share URL" />
    {/if}
  </div>

  <div class="card col">
    <div><strong>Source</strong></div>
    <div class="muted">
      mwords is open-source.
      <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" onclick={openSource}>
        {SOURCE_URL}
      </a>
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
  .share-hint { font-size: 0.85rem; }
  .manual-share { font-family: monospace; font-size: 0.8rem; }
  .hint { font-size: 0.85rem; }
  #repeat-hours { max-width: 8rem; }
</style>
