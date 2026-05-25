import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.xhaskx.mwords',
  appName: 'mwords',
  webDir: 'dist',
  plugins: {
    // Capacitor 8's built-in SystemBars handles edge-to-edge with
    // insetsHandling: 'css' by default — it injects
    // --safe-area-inset-* CSS vars on documentElement that our
    // app.css consumes via var() + env() fallbacks.
    Keyboard: {
      resize: 'native',
    },
  },
};

export default config;
