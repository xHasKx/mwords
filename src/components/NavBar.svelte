<script lang="ts">
  import { app } from '../lib/stores/app.svelte.ts';
  import ConnectionBadge from './ConnectionBadge.svelte';

  type View = 'review' | 'edit' | 'settings';
  function go(v: View) {
    app.navTo(v);
  }
  function switchDeck() {
    app.switchDeck();
  }

  const groupName = $derived(
    app.activeGroupId ? (app.groups.get(app.activeGroupId)?.name ?? '') : '',
  );
  // Right-hand label of the breadcrumb, summarising current review
  // scope when no single deck is active. Edit always operates on
  // the active deck (broad scopes narrow on entry), so the label
  // reflects the live scope for Review and the active deck for Edit.
  const deckLabel = $derived.by((): string => {
    const scope = app.reviewScope;
    if (scope.kind === 'group') return 'all decks';
    if (scope.kind === 'decks') {
      const n = scope.deckIds.length;
      return `${n} deck${n === 1 ? '' : 's'}`;
    }
    const did = app.activeDeckId;
    if (!did) return '—';
    return app.decks.get(did)?.name ?? '—';
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
<div class="nav-wrap">
  {#if groupName}
    <div class="crumb muted" aria-label="Active group and deck">
      <span class="crumb-group">{groupName}</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-deck">{deckLabel}</span>
    </div>
  {/if}
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
    <button
      class="tab icon"
      onclick={switchDeck}
      aria-label="Switch deck"
      title="Switch deck"
    >⇄</button>
    <div class="badge-wrap"><ConnectionBadge /></div>
  </nav>
</div>

<style>
  .nav-wrap {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    transform: translateZ(0);
    will-change: transform;
  }
  .crumb {
    background: var(--bg-2);
    border-top: 1px solid var(--border);
    font-size: 0.8rem;
    padding: 0.25rem 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    overflow: hidden;
    white-space: nowrap;
  }
  .crumb-group,
  .crumb-deck {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .crumb-group {
    flex: 0 1 auto;
    max-width: 50%;
  }
  .crumb-deck {
    flex: 1 1 auto;
  }
  .crumb-sep {
    flex: 0 0 auto;
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
  .tab.icon {
    font-size: 1.4rem;
    line-height: 1;
    padding: 0.5rem 0.25rem;
  }
  .tab.active {
    color: var(--accent);
    font-weight: 600;
  }
  .tab.icon.active {
    filter: drop-shadow(0 0 0.3rem var(--accent));
  }
  .badge-wrap {
    padding: 0 0.5rem;
    border-left: 1px solid var(--border);
    margin-left: 0.25rem;
  }
</style>
