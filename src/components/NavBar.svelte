<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import ConnectionBadge from './ConnectionBadge.svelte';

  type View = 'review' | 'edit' | 'settings';
  function go(v: View) { app.navTo(v); }
  function switchGroup() { app.switchGroup(); }
</script>

<!--
  Wrapper / inner split: the wrapper is the position:fixed element and
  carries the GPU-promotion hint, so the URL-bar collapse/expand on
  mobile doesn't trigger a layout pass for the bar (reduces the
  scroll-time bounce on Firefox Android). The inner <nav> stays
  layout-pristine so env(safe-area-inset-bottom) resolves normally
  inside it — applying `transform` directly to a fixed element changes
  how the browser computes that env value and re-introduces the
  inflated-height bug at the top of the page.
-->
<div class="nav-wrap">
  <nav class="nav" aria-label="Main">
    <button
      class="tab icon"
      class:active={app.view === 'review'}
      aria-current={app.view === 'review' ? 'page' : undefined}
      aria-label="Review"
      title="Review"
      onclick={() => go('review')}
    >📖</button>
    <button
      class="tab icon"
      class:active={app.view === 'edit'}
      aria-current={app.view === 'edit' ? 'page' : undefined}
      aria-label="Edit"
      title="Edit"
      onclick={() => go('edit')}
    >📝</button>
    <button
      class="tab icon"
      class:active={app.view === 'settings'}
      aria-current={app.view === 'settings' ? 'page' : undefined}
      aria-label="Settings"
      title="Settings"
      onclick={() => go('settings')}
    >⚙</button>
    <button class="tab icon" onclick={switchGroup} aria-label="Switch group" title="Switch group">⇄</button>
    <div class="badge-wrap"><ConnectionBadge /></div>
  </nav>
</div>

<style>
  .nav-wrap {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    z-index: 40;
    transform: translateZ(0);
    will-change: transform;
  }
  .nav {
    background: var(--bg-2);
    border-top: 1px solid var(--border);
    padding: 0.4rem 0.5rem;
    padding-bottom: calc(0.4rem + var(--safe-bottom));
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .tab {
    flex: 1;
    background: transparent;
    border: none;
    min-height: 48px;
    color: var(--fg-2);
    font-size: 0.9rem;
  }
  .tab.icon { font-size: 1.4rem; line-height: 1; padding: 0.5rem 0.25rem; }
  .tab.active { color: var(--accent); font-weight: 600; }
  .tab.icon.active { filter: drop-shadow(0 0 0.3rem var(--accent)); }
  .badge-wrap {
    padding: 0 0.5rem;
    border-left: 1px solid var(--border);
    margin-left: 0.25rem;
  }
</style>
