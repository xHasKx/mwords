import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { queue } from './lib/mqtt/queue.ts';
import { app as appStore } from './lib/stores/app.svelte.ts';

const app = mount(App, { target: document.getElementById('app')! });

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__mwords = { queue, app: appStore };
}

export default app;
