// Barrel for the main-process auth layer.
//
// Re-exports the in-memory session store (Phase 2, task 2.5). The
// `AuthService` (Phase 3, task 3.1) and the `auth:*` IPC handlers
// (Phase 3, task 3.2) will be added here in later phases so callers can
// `import { ... } from '@main/auth'` without coupling to the file layout.

export {
  bind,
  clear,
  clearAll,
  get,
  sessionStore,
  type SenderId,
  type Session,
} from './session-store.js';
