<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import { queueStore } from '../lib/stores/queue.svelte.ts';

  const colors: Record<string, string> = {
    idle: 'var(--fg-3)',
    connecting: 'var(--warn)',
    connected: 'var(--ok)',
    reconnecting: 'var(--warn)',
    error: 'var(--danger)',
  };

  let nowTick = $state(Date.now());

  // 1 Hz tick while we have a countdown to render. Refresh nowTick
  // immediately on transition so the first render isn't stale.
  $effect(() => {
    if (app.connection !== 'reconnecting' || app.nextAttemptAt === null) return;
    nowTick = Date.now();
    const id = setInterval(() => (nowTick = Date.now()), 1000);
    return () => clearInterval(id);
  });

  const pendingTitle = $derived(
    `${queueStore.pendingCount} pending change${queueStore.pendingCount === 1 ? '' : 's'} waiting to be sent to the broker`,
  );

  const statusText = $derived.by(() => {
    if (app.connection === 'reconnecting') {
      if (app.nextAttemptAt !== null) {
        const secs = Math.max(0, Math.ceil((app.nextAttemptAt - nowTick) / 1000));
        return `Reconnecting in ${secs}s`;
      }
      return 'Reconnecting…';
    }
    if (app.connection === 'connecting') return 'Connecting…';
    if (app.connection === 'connected') return 'Connected';
    if (app.connection === 'error') return 'Error';
    return 'Disconnected';
  });

  const reconnectSecs = $derived.by(() => {
    if (app.connection !== 'reconnecting' || app.nextAttemptAt === null) return null;
    return Math.max(0, Math.ceil((app.nextAttemptAt - nowTick) / 1000));
  });
</script>

<div class="badge" title={app.connectionError ?? statusText} aria-label={statusText}>
  <span class="dot" style:background={colors[app.connection]}></span>
  {#if reconnectSecs !== null}
    <span class="secs" aria-hidden="true">{reconnectSecs}s</span>
  {/if}
  <span
    class="pending"
    style:visibility={queueStore.pendingCount >= 2 ? 'visible' : 'hidden'}
    aria-label={pendingTitle}
    title={pendingTitle}
    aria-hidden={queueStore.pendingCount >= 2 ? undefined : 'true'}
  >
    {queueStore.pendingCount}
  </span>
</div>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--fg-2);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }
  .secs {
    font-size: 0.75rem;
    color: var(--fg-3);
    font-variant-numeric: tabular-nums;
  }
  .pending {
    color: var(--fg-3);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    min-width: 2ch;
    text-align: right;
    padding: 0.05rem 0.35rem;
    border-radius: 999px;
    background: var(--bg-3);
  }
</style>
