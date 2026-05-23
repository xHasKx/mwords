<script lang="ts">
  import { app } from './lib/stores/app.svelte.ts';
  import ConnectionForm from './components/ConnectionForm.svelte';
  import NavBar from './components/NavBar.svelte';
  import GroupPickerView from './views/GroupPickerView.svelte';
  import ReviewView from './views/ReviewView.svelte';
  import EditView from './views/EditView.svelte';
  import SettingsView from './views/SettingsView.svelte';

  app.init();

  const showNav = $derived(
    app.view === 'review' || app.view === 'edit' || app.view === 'settings',
  );
  const showGroupHeader = $derived(app.view === 'review' || app.view === 'edit');
  const groupName = $derived(
    app.activeGroupId ? app.groups.get(app.activeGroupId)?.name ?? '' : '',
  );
</script>

{#if showGroupHeader && groupName}
  <h1 class="group-header">{groupName}</h1>
{/if}

{#if app.view === 'connect'}
  <ConnectionForm />
{:else if app.view === 'picker'}
  <GroupPickerView />
{:else if app.view === 'review'}
  <ReviewView />
{:else if app.view === 'edit'}
  <EditView />
{:else if app.view === 'settings'}
  <SettingsView />
{/if}

{#if showNav}
  <NavBar />
{/if}

{#if app.switching}
  <div class="switching" role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <div>Loading group…</div>
  </div>
{/if}

<style>
  .group-header {
    margin: 0 0 0.75rem;
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--fg-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .switching {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.55);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    color: white;
    z-index: 200;
  }
  .spinner {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 3px solid rgba(255,255,255,0.25);
    border-top-color: white;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
  }
</style>
