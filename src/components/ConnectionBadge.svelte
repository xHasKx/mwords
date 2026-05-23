<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';

  const labels: Record<string, string> = {
    idle: 'Disconnected',
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    error: 'Error',
  };

  const colors: Record<string, string> = {
    idle: 'var(--fg-3)',
    connecting: 'var(--warn)',
    connected: 'var(--ok)',
    reconnecting: 'var(--warn)',
    error: 'var(--danger)',
  };
</script>

<div class="badge" title={app.connectionError ?? labels[app.connection]}>
  <span class="dot" style:background={colors[app.connection]}></span>
  <span class="text">{labels[app.connection]}</span>
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
</style>
