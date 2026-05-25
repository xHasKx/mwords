import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [
    svelte(),
    visualizer({ filename: 'dist/stats.html', gzipSize: true, brotliSize: true }),
  ],
  // Relative base so the same dist/ works under GitHub Pages
  // (xhaskx.github.io/mwords/) and inside the Capacitor WebView
  // (https://localhost/). Absolute /mwords/ would 404 on the latter.
  base: './',
  server: { port: 5173, host: true },
});
