<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import { pickNext } from '../lib/srs/picker.ts';
  import { defaultSrs } from '../lib/types.ts';
  import ReviewCard from '../components/ReviewCard.svelte';
  import GradeButtons from '../components/GradeButtons.svelte';
  import type { Grade } from '../lib/types.ts';

  let revealed = $state(false);
  let previousId = $state<string | undefined>(undefined);

  const wordsArray = $derived(Array.from(app.words.values()));
  const now = $state({ ts: Date.now() / 1000 });

  // Refresh `now` after each grade so the picker re-evaluates "due".
  function bumpNow() { now.ts = Date.now() / 1000; }

  const current = $derived(
    pickNext({
      words: wordsArray,
      srs: app.srs,
      settings: app.settings,
      now: now.ts,
      previousId,
    }),
  );

  const front = $derived(
    current ? (app.settings.direction === 'translation' ? current.translation : current.text) : '',
  );
  const back = $derived(
    current ? (app.settings.direction === 'translation' ? current.text : current.translation) : '',
  );

  // Reset the reveal when the prompt side changes (new card or direction flip).
  $effect(() => {
    void front;
    revealed = false;
  });

  function onGrade(g: Grade) {
    const w = current;
    if (!w) return;
    app.grade(w.id, g);
    previousId = w.id;
    revealed = false;
    bumpNow();
  }
</script>

<div class="col">
  {#if wordsArray.length === 0}
    <div class="card muted">
      <p>No words yet in this group.</p>
      <p>Switch to <strong>Edit</strong> below to add some.</p>
    </div>
  {:else if current}
    <ReviewCard {front} {back} {revealed} onReveal={() => (revealed = true)} />
    {#if revealed}
      <GradeButtons srs={app.srs.get(current.id) ?? defaultSrs(current.id)} {onGrade} />
    {/if}
  {:else}
    <div class="card muted">
      <p>No cards due right now.</p>
      <p>Switch to <strong>Edit</strong> to add or modify words.</p>
    </div>
  {/if}
</div>
