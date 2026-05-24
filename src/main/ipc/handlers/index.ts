// Barrel for IPC channel-group handlers.
//
// Each module under this folder owns a logical group of channels and
// exposes a `registerXxxHandlers()` entry point. The main-process
// bootstrap (`src/main/index.ts`) imports those entry points and calls
// each one before `bindIpcHandlers(ipcMain)` so the router is fully
// populated before Electron exposes the IPC surface to renderers.
//
// As each phase comes online its handler module joins this barrel:
//   - auth.ts      (Phase 3, task 3.2)  — auth:login, auth:logout,
//                                          setup:createInitialAdmin
//   - products.ts  (Phase 4)            — products:list/count/upsert
//   - pos.ts       (Phase 7)            — pos:scan, pos:finalize
//   - …

export { registerAuthHandlers } from './auth.js';
