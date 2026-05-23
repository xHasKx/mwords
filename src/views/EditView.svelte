<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import WordEditor from '../components/WordEditor.svelte';
  import type { Word } from '../lib/types.ts';

  const words = $derived(
    Array.from(app.words.values()).sort((a, b) => Number(b.id) - Number(a.id)),
  );

  // Modal state lives in the store so the popstate listener can close it.
  const editingWordId = $derived(
    app.modal?.kind === 'word-editor' ? app.modal.wordId ?? null : null,
  );
  const editorOpen = $derived(app.modal?.kind === 'word-editor');
  const editorWord: Word | null = $derived(
    editingWordId !== null ? app.words.get(editingWordId) ?? null : null,
  );

  function openAdd() { app.openWordEditor(); }
  function openEdit(w: Word) { app.openWordEditor(w.id); }
  function close() { app.goBack(); }

  async function save(text: string, translation: string) {
    if (editorWord) await app.updateWord(editorWord.id, text, translation);
    else await app.addWord(text, translation);
  }

  async function remove() {
    if (editorWord) await app.deleteWord(editorWord.id);
  }
</script>

<div class="col">
  {#if words.length === 0}
    <div class="card muted">No words yet. Tap + to add one.</div>
  {:else}
    <ul class="words">
      {#each words as w (w.id)}
        <li>
          <button class="word-row" onclick={() => openEdit(w)}>
            <div class="text">{w.text}</div>
            <div class="translation muted">{w.translation}</div>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <button class="fab primary" onclick={openAdd} aria-label="Add word">+</button>
</div>

{#if editorOpen}
  {#key editingWordId ?? '__new__'}
    <WordEditor
      initial={editorWord}
      onSave={save}
      onDelete={editorWord ? remove : undefined}
      onClose={close}
    />
  {/key}
{/if}

<style>
  .words { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .word-row {
    width: 100%;
    text-align: left;
    background: var(--bg-2);
    padding: 0.75rem 1rem;
    border-radius: 8px;
  }
  .text { font-size: 1rem; }
  .translation { font-size: 0.9rem; }
  .fab {
    position: fixed;
    right: 1.25rem;
    bottom: calc(80px + env(safe-area-inset-bottom));
    width: 56px; height: 56px;
    border-radius: 50%;
    font-size: 1.6rem;
    line-height: 1;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 50;
  }
</style>
