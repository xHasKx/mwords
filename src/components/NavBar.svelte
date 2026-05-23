<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import ConnectionBadge from './ConnectionBadge.svelte';

  type View = 'review' | 'edit' | 'settings';
  function go(v: View) { app.view = v; }
  function switchGroup() { app.switchGroup(); }
</script>

<nav class="nav" aria-label="Main">
  <button class="tab" class:active={app.view === 'review'} aria-current={app.view === 'review' ? 'page' : undefined} onclick={() => go('review')}>Review</button>
  <button class="tab" class:active={app.view === 'edit'} aria-current={app.view === 'edit' ? 'page' : undefined} onclick={() => go('edit')}>Edit</button>
  <button class="tab" class:active={app.view === 'settings'} aria-current={app.view === 'settings' ? 'page' : undefined} onclick={() => go('settings')}>Settings</button>
  <button class="tab" onclick={switchGroup} aria-label="Switch group" title="Switch group">⇄</button>
  <div class="badge-wrap"><ConnectionBadge /></div>
</nav>

<style>
  .nav {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    background: var(--bg-2);
    border-top: 1px solid var(--border);
    padding: 0.4rem 0.5rem;
    padding-bottom: calc(0.4rem + env(safe-area-inset-bottom));
    display: flex;
    align-items: center;
    gap: 0.25rem;
    z-index: 40;
  }
  .tab {
    flex: 1;
    background: transparent;
    border: none;
    min-height: 48px;
    color: var(--fg-2);
    font-size: 0.9rem;
  }
  .tab.active { color: var(--accent); font-weight: 600; }
  .badge-wrap {
    padding: 0 0.5rem;
    border-left: 1px solid var(--border);
    margin-left: 0.25rem;
  }
</style>
