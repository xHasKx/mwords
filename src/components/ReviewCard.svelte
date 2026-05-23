<script lang="ts">
  import type { Word } from '../lib/types.ts';

  type Props = { word: Word; revealed: boolean; onReveal: () => void };
  let { word, revealed, onReveal }: Props = $props();
</script>

<button class="card review" type="button" onclick={onReveal} aria-expanded={revealed}>
  <div class="front">{word.text}</div>
  {#if revealed}
    <hr />
    <div class="back">{word.translation}</div>
  {:else}
    <div class="hint muted">Tap to reveal</div>
  {/if}
</button>

<style>
  .review {
    width: 100%;
    text-align: center;
    padding: 2rem 1rem;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    min-height: 200px;
    color: var(--fg);
    cursor: pointer;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .front {
    font-size: 1.7rem;
    font-weight: 500;
  }
  .back {
    font-size: 1.4rem;
    color: var(--fg-2);
  }
  hr {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 1.2rem 0;
  }
  .hint {
    margin-top: 1.5rem;
    font-size: 0.85rem;
  }
</style>
