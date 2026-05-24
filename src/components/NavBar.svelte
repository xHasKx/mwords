<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import ConnectionBadge from './ConnectionBadge.svelte';

  type View = 'review' | 'edit' | 'settings';
  function go(v: View) { app.navTo(v); }
  function switchGroup() { app.switchGroup(); }

  let wrapEl: HTMLDivElement | null = $state(null);
  let dbg = $state('');
  // The largest innerHeight observed so far — proxy for the
  // URL-bar-collapsed (lvh) viewport. Firefox on Android anchors
  // position:fixed;bottom:0 to this even when the URL bar is up and
  // the current layout viewport is shorter — leaving a gap between
  // the nav and the visible bottom. Translate DOWN by (lvh - ih) to
  // close it.
  let lvh = 0;

  $effect(() => {
    if (typeof window === 'undefined') return;
    function sync() {
      if (!wrapEl) return;
      const ih = window.innerHeight;
      if (ih > lvh) lvh = ih;
      const lift = Math.max(0, lvh - ih);
      wrapEl.style.transform = `translate3d(0, ${lift}px, 0)`;
      dbg = `ih=${ih} lvh=${lvh} lift=${lift}`;
    }
    sync();
    window.addEventListener('resize', sync);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', sync);
    vv?.addEventListener('scroll', sync);
    return () => {
      window.removeEventListener('resize', sync);
      vv?.removeEventListener('resize', sync);
      vv?.removeEventListener('scroll', sync);
    };
  });
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
<div class="nav-wrap" bind:this={wrapEl}>
  <div class="dbg">{dbg}</div>
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
    /* transform set inline by the $effect above (translate3d for both
       compositor promotion and the Firefox-Android lift). */
    will-change: transform;
  }
  .dbg {
    position: absolute;
    left: 4px;
    bottom: 100%;
    font-size: 10px;
    font-family: monospace;
    color: yellow;
    background: rgba(0,0,0,0.6);
    padding: 2px 4px;
    pointer-events: none;
  }
  .nav {
    background: var(--bg-2);
    border-top: 1px solid var(--border);
    padding: 0.4rem 0.5rem;
    padding-bottom: calc(0.4rem + min(env(safe-area-inset-bottom), 40px));
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
