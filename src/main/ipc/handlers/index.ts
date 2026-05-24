// Barrel for IPC channel-group handlers.
//
// Each module under this folder owns a logical group of channels and
// exposes a `registerXxxHandlers()` entry point. The main-process
// bootstrap (`src/main/index.ts`) imports those entry points and calls
// each one before `bindIpcHandlers(ipcMain)` so the router is fully
// populated before Electron exposes the IPC surface to renderers.
//
// As each phase comes online its handler module joins this barrel:
//   - auth.ts       (Phase 3, task 3.2)  — auth:login, auth:logout,
//                                           setup:createInitialAdmin
//   - categories.ts (Phase 4, task 4.1)  — categories:list/upsert/delete
//   - products.ts   (Phase 4, task 4.2)  — products:list/count/upsert
//   - inventory.ts  (Phase 5, tasks 5.2 + 5.3) — inventory:adjust,
//                                           inventory:lowStockCount
//   - reports.ts    (Phase 5, task 5.3)  — reports:lowStock
//                                          (Phase 10 extends this with
//                                           dailySales / monthlySales /
//                                           topSelling / export)
//   - pos.ts        (Phase 7, task 7.2)  — pos:scan
//                                          (task 7.4 will add pos:finalize)
//   - …

export { registerAuthHandlers } from './auth.js';
export { registerCategoriesHandlers } from './categories.js';
export { registerCustomersHandlers } from './customers.js';
export { registerInventoryHandlers } from './inventory.js';
export { registerPosHandlers } from './pos.js';
export { registerProductsHandlers } from './products.js';
export { registerPurchasesHandlers } from './purchases.js';
export { registerReportsHandlers } from './reports.js';
export { registerSettingsHandlers } from './settings.js';
export { registerSuppliersHandlers } from './suppliers.js';
