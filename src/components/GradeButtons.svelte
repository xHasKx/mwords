<script lang="ts">
  import type { Grade, SrsState } from '../lib/types.ts';
  import { nextIntervalDaysFor } from '../lib/srs/sm2.ts';

  type Props = { srs: SrsState; onGrade: (g: Grade) => void };
  let { srs, onGrade }: Props = $props();

  const labels: { g: Grade; text: string }[] = [
    { g: 'again', text: 'Again' },
    { g: 'hard', text: 'Hard' },
    { g: 'good', text: 'Good' },
    { g: 'easy', text: 'Easy' },
  ];

  function summary(g: Grade): string {
    const d = nextIntervalDaysFor(srs, g);
    return d === 0 ? 'now' : `${d}d`;
  }
</script>

<div class="grades">
  {#each labels as { g, text } (g)}
    <button class="grade" data-grade={g} onclick={() => onGrade(g)}>
      <span class="text">{text}</span>
      <span class="hint muted">{summary(g)}</span>
    </button>
  {/each}
</div>

<style>
  .grades { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; }
  .grade {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    min-height: 60px;
    padding: 0.5rem 0.25rem;
  }
  .text { font-size: 0.95rem; font-weight: 500; }
  .hint { font-size: 0.75rem; }
  .grade[data-grade='again'] { border-color: var(--danger); color: var(--danger); }
  .grade[data-grade='easy']  { border-color: var(--ok); color: var(--ok); }
</style>
