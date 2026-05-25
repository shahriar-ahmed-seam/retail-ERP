/**
 * Renderer entry point (task 0.5; rewired in task 13.1; migration
 * progress branch added in Phase 16 task 16.7).
 *
 * Mounts the renderer tree with the order:
 *
 *   <StrictMode>
 *     <AuthProvider>
 *       <App />            ← src/renderer/App.tsx (task 13.1)
 *     </AuthProvider>
 *   </StrictMode>
 *
 * `<App />` owns the first-run setup probe, the setup branch, and the
 * role-aware route tree. The split between `index.tsx` and `App.tsx`
 * mirrors the convention electron-vite + React projects use so a
 * future renderer-side test harness can mount `<App />` directly
 * without re-implementing the providers.
 *
 * Migration progress branch (Phase 16 task 16.7):
 *   When the bootstrap opens the migration progress `BrowserWindow`,
 *   it loads the renderer bundle with the query string
 *   `?migration=true`. We detect that here and mount
 *   `<MigrationProgressPage />` directly — bypassing the auth
 *   provider, the router, and every feature module so no protected
 *   surface is reachable while migrations run. The migration page
 *   subscribes to the unprivileged `setup:migrationProgress` channel
 *   via the preload bridge.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { MigrationProgressPage } from './features/setup';
import { AuthProvider } from './lib/auth-context';
// Global stylesheet — pins the renderer to a light color scheme and
// removes outer (`html` / `body`) scrollbars so internal scroll
// regions own their overflow. Imported here so every renderer entry
// (main app + migration progress window) picks it up.
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element #root not found in index.html');
}

/**
 * Detect whether the migration progress window mounted us. The
 * bootstrap appends `?migration=true` to the renderer URL when it
 * loads the page; reading `window.location.search` is sufficient
 * because the migration window is a static load (no client-side
 * routing happens before this check).
 */
function isMigrationProgressEntry(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('migration') === 'true';
}

if (isMigrationProgressEntry()) {
  createRoot(container).render(
    <StrictMode>
      <MigrationProgressPage />
    </StrictMode>,
  );
} else {
  createRoot(container).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>,
  );
}
