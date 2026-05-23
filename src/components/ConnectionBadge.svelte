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

  const text = $derived.by(() => {
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
</script>

<div class="badge" title={app.connectionError ?? text}>
  <span class="dot" style:background={colors[app.connection]}></span>
  <span class="text">{text}</span>
  {#if queueStore.pendingCount > 0}
    <span class="pending">· {queueStore.pendingCount} pending</span>
  {/if}
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
  .pending {
    color: var(--fg-3);
    font-size: 0.8rem;
  }
</style>
