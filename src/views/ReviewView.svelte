<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '../lib/stores/app.svelte.ts';
  import { pickNext } from '../lib/srs/picker.ts';
  import { defaultSrs } from '../lib/types.ts';
  import ReviewCard from '../components/ReviewCard.svelte';
  import GradeButtons from '../components/GradeButtons.svelte';
  import type { Grade } from '../lib/types.ts';

  let revealed = $state(false);
  let previousId = $state<string | undefined>(undefined);
  // Per-session reviewed counter. Component is unmounted/remounted
  // when the user leaves and returns to the Review view, so this
  // resets to 0 each time the page is opened.
  let reviewed = $state(0);
  // Chosen-word id is explicit state, not a derived. The weighted picker
  // uses Math.random; if it were a derived it would re-run on every
  // reactive ripple (post-grade publish round-trip, retained replay,
  // peer sync) and a different random card would settle each time,
  // causing the user to see one card flash and another appear.
  let currentId = $state<string | undefined>(undefined);
  const now = $state({ ts: Date.now() / 1000 });

  function bumpNow() { now.ts = Date.now() / 1000; }

  // Re-pick only on events that should advance the card: initial mount,
  // a grade (previousId changes), SRS mode flip, current word deleted,
  // scope change, or word list arriving from empty. Updates to app.srs
  // itself must NOT trigger a re-pick — that's the skip-a-card bug.
  $effect(() => {
    // Track the derived array reference itself, not just .length —
    // an edit / peer rename rebuilds scopedWords with the same length,
    // and we want the picker re-eval to fire then too.
    void app.scopedWords;
    void app.settings.srsMode;
    void app.reviewScope;
    void previousId;
    untrack(() => {
      const wordsArray = app.scopedWords;
      if (wordsArray.length === 0) {
        currentId = undefined;
        return;
      }
      // Keep current if it's still valid and the user hasn't just graded.
      if (currentId && currentId !== previousId && wordsArray.some((w) => w.id === currentId)) {
        return;
      }
      const picked = pickNext({
        words: wordsArray,
        srs: app.srs,
        settings: app.settings,
        now: now.ts,
        previousId,
      });
      currentId = picked?.id;
    });
  });

  const current = $derived(currentId ? (app.words.get(currentId) ?? null) : null);

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
    reviewed += 1;
    bumpNow();
  }
</script>

<div class="col">
  <div class="counter muted" aria-live="polite">Reviewed: {reviewed}</div>
  {#if app.scopedWords.length === 0}
    <div class="card muted">
      <p>No words in this scope.</p>
      <p>Switch to <strong>Edit</strong> below to add some, or broaden the review scope.</p>
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

<style>
  .counter {
    font-size: 0.85rem;
    text-align: right;
  }
</style>
