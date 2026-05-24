// src/main/ipc/handlers/categories.ts
//
// IPC handlers for the categories channel group (Phase 4, task 4.1).
//
// Wires three channels into the router (`registerHandler`) on import via
// the exported `registerCategoriesHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this after `registerAuthHandlers()` and
// before `bindIpcHandlers(ipcMain)` so the router is fully populated
// before Electron exposes the IPC surface to renderers.
//
// Channels:
//
//   - `categories:list`   (Admin + Cashier; cashiers may see categories
//                          for product display per Req 2.5 / 8.3)
//       Thin adapter — forwards directly to `CategoryService.list()`.
//
//   - `categories:upsert` (Admin only — Req 2.5: only Admin manages catalog)
//       Forwards to `CategoryService.upsert(input)`. RBAC denial for the
//       Cashier role is handled by the router middleware against the
//       static matrix (`src/main/permission/matrix.ts`); this handler
//       does not re-check.
//
//   - `categories:delete` (Admin only)
//       Forwards to `CategoryService.delete(id)`. The service contains
//       the "no products reference" guard and surfaces
//       `Err('FK_VIOLATION', { reason: 'category_in_use' })` when the
//       delete would orphan products.
//
// Validates: Requirement 2.5.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { CategoryService } from '@main/services/category.service.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `categories:list` handler. Returns every category ordered by name asc.
 * The channel is unpaginated by design — the categories table is small
 * (a few dozen rows for a single shop) and benefits from a single
 * round-trip to the renderer for filter dropdowns and the catalog page.
 */
const listHandler: HandlerFn<'categories:list'> = async () => {
  return CategoryService.list();
};

/**
 * `categories:upsert` handler. Create or update by id. Validation, name
 * trimming, and unique-constraint mapping live in the service.
 */
const upsertHandler: HandlerFn<'categories:upsert'> = async (req) => {
  return CategoryService.upsert(req);
};

/**
 * `categories:delete` handler. Conditional delete — only succeeds when
 * no `Product` rows reference the category. The service maps the two
 * failure modes to distinct `FK_VIOLATION` reasons (`category_in_use`
 * vs `not_found`).
 */
const deleteHandler: HandlerFn<'categories:delete'> = async (req) => {
  return CategoryService.delete(req.id);
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every categories-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this twice
 * (e.g. under HMR or in tests) is safe.
 */
export function registerCategoriesHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware enforces
  // that only authenticated sessions reach these handlers. Per the
  // matrix:
  //   - `categories:list` allows Admin + Cashier
  //   - `categories:upsert` and `categories:delete` allow Admin only
  registerHandler('categories:list', {}, listHandler);
  registerHandler('categories:upsert', {}, upsertHandler);
  registerHandler('categories:delete', {}, deleteHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/categories.test.ts` so the handler
// functions can be exercised directly without driving the full router.
// Production code should always go through `registerCategoriesHandlers`.
export const __testables = Object.freeze({
  listHandler,
  upsertHandler,
  deleteHandler,
});
