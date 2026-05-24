<script lang="ts">
  import { untrack } from 'svelte';
  import type { Word } from '../lib/types.ts';

  type Props = {
    initial: Word | null;
    onSave: (text: string, translation: string) => Promise<void>;
    onDelete?: () => Promise<void>;
    onClose: () => void;
  };
  let { initial, onSave, onDelete, onClose }: Props = $props();

  // Capture the initial values once at mount — this dialog is re-mounted
  // per open, so we don't want the inputs to snap back if `initial` ever
  // changes. `untrack` makes that explicit (and silences the lint).
  let text = $state(untrack(() => initial?.text ?? ''));
  let translation = $state(untrack(() => initial?.translation ?? ''));
  let busy = $state(false);
  let error = $state<string | null>(null);
  let textInput: HTMLInputElement | null = $state(null);

  // Focus the Text field as soon as the dialog mounts — the user
  // tapped + (or a row) intending to type, so move the caret there.
  $effect(() => {
    textInput?.focus();
  });

  async function save(e: Event) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await onSave(text, translation);
      onClose();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  // Save the current word but keep the modal open, with the inputs
  // cleared and focus back on Text. Lets the user batch several adds
  // without re-opening the editor each time. Only shown in add mode.
  async function saveAndAddMore() {
    busy = true;
    error = null;
    try {
      await onSave(text, translation);
      text = '';
      translation = '';
      textInput?.focus();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!onDelete) return;
    if (!confirm('Delete this word?')) return;
    busy = true;
    try {
      await onDelete();
      onClose();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="backdrop" onclick={onClose} role="presentation"></div>
<div class="sheet" role="dialog" aria-modal="true">
  <form class="col" onsubmit={save}>
    <h2>{initial ? 'Edit word' : 'Add word'}</h2>
    <div>
      <label for="text">Text</label>
      <input id="text" bind:this={textInput} bind:value={text} autocapitalize="off" autocomplete="off" />
    </div>
    <div>
      <label for="tr">Translation</label>
      <input id="tr" bind:value={translation} autocapitalize="off" autocomplete="off" />
    </div>
    {#if error}<div class="error">{error}</div>{/if}
    <div class="row actions">
      <button type="button" onclick={onClose}>Cancel</button>
      {#if initial && onDelete}
        <button type="button" class="danger" onclick={remove} disabled={busy}>Delete</button>
      {/if}
      {#if !initial}
        <button
          type="button"
          onclick={saveAndAddMore}
          disabled={busy || !text.trim() || !translation.trim()}
        >
          Add more
        </button>
      {/if}
      <button type="submit" class="primary" disabled={busy || !text.trim() || !translation.trim()}>
        Save
      </button>
    </div>
  </form>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 90;
  }
  .sheet {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    background: var(--bg);
    border-top: 1px solid var(--border);
    border-top-left-radius: 16px;
    border-top-right-radius: 16px;
    padding: 1.25rem;
    padding-bottom: calc(1.25rem + var(--safe-bottom));
    max-height: 90vh;
    overflow-y: auto;
    z-index: 100;
  }
  .actions { justify-content: flex-end; margin-top: 0.5rem; }
</style>
