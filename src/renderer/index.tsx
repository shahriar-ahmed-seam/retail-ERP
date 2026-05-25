/**
 * Renderer entry point (task 0.5; rewired in task 13.1).
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
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { AuthProvider } from './lib/auth-context';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
