<script lang="ts">
  import { App as CapacitorApp } from '@capacitor/app';
  import { Capacitor } from '@capacitor/core';
  import { Keyboard } from '@capacitor/keyboard';
  import { app } from './lib/stores/app.svelte.ts';
  import ConnectionForm from './components/ConnectionForm.svelte';
  import NavBar from './components/NavBar.svelte';
  import GroupPickerView from './views/GroupPickerView.svelte';
  import DeckPickerView from './views/DeckPickerView.svelte';
  import ReviewView from './views/ReviewView.svelte';
  import EditView from './views/EditView.svelte';
  import SettingsView from './views/SettingsView.svelte';

  app.init();

  // Capacitor 8's built-in SystemBars plugin injects --safe-area-inset-*
  // CSS vars and handles edge-to-edge automatically (default
  // insetsHandling: 'css'). No JS init needed — our app.css consumes
  // those vars directly.
  if (Capacitor.isNativePlatform()) {
    // Diagnose keyboard behavior. Logs are visible in chrome://inspect's
    // Console and tell us whether (a) the listener fires at all, (b)
    // window.innerHeight reflects the post-keyboard viewport (= WebView
    // was resized) or stays full (= our resize:'none' config worked),
    // and (c) where the focused input actually sits in the doc.
    void Keyboard.addListener('keyboardDidShow', (info) => {
      const focused = document.activeElement as HTMLElement | null;
      const tag = focused?.tagName;
      const rect = focused?.getBoundingClientRect();
      console.log('[mwords] keyboardDidShow', {
        keyboardHeight: info?.keyboardHeight,
        innerHeight: window.innerHeight,
        visualViewport: window.visualViewport
          ? {
              height: window.visualViewport.height,
              width: window.visualViewport.width,
              offsetTop: window.visualViewport.offsetTop,
            }
          : null,
        scrollY: window.scrollY,
        bodyHeight: document.body.getBoundingClientRect().height,
        focusedTag: tag,
        focusedRect: rect
          ? { top: rect.top, bottom: rect.bottom, height: rect.height }
          : null,
      });
      if (
        focused instanceof HTMLInputElement ||
        focused instanceof HTMLTextAreaElement
      ) {
        focused.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });

    // Hardware back button: route through the synthetic history stack
    // (pushState entries) so OS back matches in-app back. canGoBack
    // reflects WebView history, which pushState updates; when there's
    // no prior entry, exit the app.
    void CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      } else {
        void CapacitorApp.exitApp();
      }
    });

    // Deep-link arrivals (intent filter in AndroidManifest matches
    // https://xhaskx.github.io/mwords/...). Fires both on cold-launch
    // and while the app is already running. The store decides whether
    // to tear down the current session before applying the new creds.
    void CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      app.applyShareUrl(url);
    });
  }

  // Nav is visible whenever the user has a "scope" to navigate within.
  // Connect form and the group picker (post-connect landing) intentionally
  // omit it. Deck picker shows it so the user can hop to settings without
  // committing to a deck.
  const showNav = $derived(
    app.view === 'review' ||
      app.view === 'edit' ||
      app.view === 'settings' ||
      app.view === 'deck-picker',
  );
</script>

{#if app.view === 'connect'}
  <!-- Re-key on shareImport so a deep-link arrival while the form is
       already visible re-runs its one-shot prefill from the new payload. -->
  {#key app.shareImport}
    <ConnectionForm />
  {/key}
{:else if app.view === 'picker'}
  <GroupPickerView />
{:else if app.view === 'deck-picker'}
  <DeckPickerView />
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
