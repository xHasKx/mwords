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
</script>

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
  <div class="switching">
    <div class="spinner"></div>
    <div>Loading group…</div>
  </div>
{/if}

<style>
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
</style>
