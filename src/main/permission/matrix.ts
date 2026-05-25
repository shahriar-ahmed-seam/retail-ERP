/**
 * Static RBAC matrix mapping every IPC channel to the roles permitted to
 * invoke it.
 *
 * The matrix is the single source of truth consulted by the IPC router
 * middleware (see design.md > "Auth and RBAC" and the sketch in
 * `src/main/ipc/router.ts`, task 2.4):
 *
 * ```ts
 * if (!Permission.allows(session.role, channel)) {
 *   return Err('FORBIDDEN', { auditDenial: true });
 * }
 * ```
 *
 * Two design properties hang on the shape used here:
 *
 *   1. **Total coverage.** Typing the matrix as
 *      `Readonly<Record<keyof IpcContract, readonly SessionRole[]>>` makes
 *      it a TypeScript error to add a new IPC channel without declaring
 *      the roles allowed to call it. This is the static half of
 *      Property 9 (RBAC matrix exhaustiveness, task 2.8); the runtime
 *      enforcement test lives in Phase 12.
 *
 *   2. **Default-deny for `Cashier`.** The role is granted access to a
 *      narrow, explicitly enumerated set of channels (POS flow, product
 *      reads, low-stock banner, customer attach, settings reads, their
 *      own sales). Every other channel — pricing edits, inventory
 *      adjustments, audit/journal browsing, reports beyond the low-stock
 *      banner, supplier management, user/role administration, backups,
 *      settings writes — denies the cashier with `FORBIDDEN` and emits
 *      an `audit_logs` row of type `rbac.deny` (Req 8.4).
 *
 * The cashier scope mirrors the requirements:
 *
 *   - Req 8.3: cashiers get POS + read-only product/customer access.
 *   - Req 7.2 / 7.4: cashiers attach customers to sales (so
 *     `customers:upsert` is allowed — POS adds walk-in customers
 *     mid-checkout).
 *   - Req 3.6 + Req 9.3: cashiers see the low-stock banner via
 *     `inventory:lowStockCount` and open the low-stock list via
 *     `reports:lowStock`.
 *
 * **Phase 12, task 12.1.1:** every paginated list channel and its
 * `*:count` companion is now explicitly registered against one of the
 * two role tuples below — Admin-only for the historical / audit /
 * purchasing surfaces (`sales`, `purchases`, `inventory_movements`,
 * `audit`, `journal_entries`, `suppliers`) and Admin + Cashier for
 * the read-only catalog / customer browse surfaces (`products`,
 * `customers`). The earlier "cashiers see their own sales via
 * `sales:list`" carve-out is dropped: the historical sales browser
 * is an admin tool (Req 8.2), and a cashier's working surface is
 * the live POS — not a backwards-looking ledger of their own
 * receipts. Per-row scoping by `cashierId` is therefore no longer
 * required and would be dead code.
 *
 * The Property 9 runtime exhaustiveness test (task 12.3) walks every
 * `IpcContract` channel and asserts the matrix gate fires for every
 * forbidden role, so the explicit registration here is what gives
 * the property its source of truth.
 *
 * Validates: Requirements 1.5, 8.1, 8.2, 8.3, 8.4, 16.1.
 */

import type { IpcChannel, IpcContract, SessionRole } from '@shared/ipc-contract';

// ---------------------------------------------------------------------------
// Role tuples (single shared instances so the matrix stays one line per row)
// ---------------------------------------------------------------------------

const ALL_ROLES: readonly SessionRole[] = Object.freeze(['Admin', 'Cashier']);
const ADMIN_ONLY: readonly SessionRole[] = Object.freeze(['Admin']);
/**
 * Channels that no authenticated session may invoke. `setup:createInitialAdmin`
 * is the only such channel today: it is gated by `AuthService.hasAnyAdmin()`
 * and is reached only on a fresh install where no session yet exists. Listing
 * it here as `[]` makes the intent explicit — even if a session somehow
 * existed, RBAC would deny the call.
 */
const NO_ROLE: readonly SessionRole[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/**
 * Authoritative role-per-channel matrix.
 *
 * The `Record<keyof IpcContract, ...>` typing forces every channel declared
 * in `src/shared/ipc-contract.ts` to appear here. Adding a channel without
 * an entry — or removing a channel without removing its entry — fails to
 * typecheck.
 */
export const RBAC: Readonly<Record<keyof IpcContract, readonly SessionRole[]>> = Object.freeze({
  // ----- Auth & first-run setup -------------------------------------------
  // Login/logout are public from the router's perspective (no session
  // required); listing both roles here means the matrix never causes a
  // FORBIDDEN once a session does exist (e.g. logout from any role).
  'auth:login': ALL_ROLES,
  'auth:logout': ALL_ROLES,
  // Reachable only when no admin exists; the service layer (task 3.1)
  // re-checks `hasAnyAdmin()` so this is a defence-in-depth stub.
  'setup:createInitialAdmin': NO_ROLE,
  // Public probe (`requiresAuth: false` in the handler) consulted by
  // the renderer on every launch to decide whether to render the
  // setup screen before login (Req 1.6, 14.2). Like
  // `setup:createInitialAdmin`, the matrix entry is defence-in-depth
  // — the router's `requiresAuth: false` opt-out means RBAC is never
  // consulted on this channel in practice — but listing it under the
  // empty role set keeps the static "Admin or Cashier never authorize
  // setup channels" invariant explicit.
  'setup:isRequired': NO_ROLE,

  // ----- Products ---------------------------------------------------------
  // Cashiers need read access to look up items at the POS; only Admin can
  // change pricing/SKU/barcode (Req 2.4, 8.3, 13.1).
  'products:list': ALL_ROLES,
  'products:count': ALL_ROLES,
  'products:upsert': ADMIN_ONLY,

  // ----- Categories -------------------------------------------------------
  // Cashiers see categories for product display (POS lookup, list filter);
  // only Admin manages the catalog reference table (Req 2.5, 8.3).
  'categories:list': ALL_ROLES,
  'categories:upsert': ADMIN_ONLY,
  'categories:delete': ADMIN_ONLY,

  // ----- POS --------------------------------------------------------------
  'pos:scan': ALL_ROLES,
  'pos:finalize': ALL_ROLES,

  // ----- Purchases --------------------------------------------------------
  // Purchases are an Admin workflow (Req 5.1, 8.2). Cashiers have no
  // legitimate reason to read or write them.
  'purchases:list': ADMIN_ONLY,
  'purchases:count': ADMIN_ONLY,
  'purchase:create': ADMIN_ONLY,

  // ----- Inventory --------------------------------------------------------
  'inventory:adjust': ADMIN_ONLY,
  // Banner count must be visible to everyone (Req 3.6).
  'inventory:lowStockCount': ALL_ROLES,
  // The full movement ledger is an audit/admin tool.
  'inventory_movements:list': ADMIN_ONLY,
  'inventory_movements:count': ADMIN_ONLY,

  // ----- Sales (read-only history) ----------------------------------------
  // Sales history is an Admin-only audit/reporting surface (Req 8.2,
  // task 12.1.1). The cashier-facing surface is the live POS screen;
  // browsing the historical sales ledger is not part of the cashier
  // workflow. Listed Admin-only here so Property 9 (task 12.3) sees a
  // consistent denial path for cashiers.
  'sales:list': ADMIN_ONLY,
  'sales:count': ADMIN_ONLY,

  // ----- Customers --------------------------------------------------------
  // Cashiers attach customers to sales (Req 7.2) — including creating a
  // walk-in record mid-checkout — and look up prior purchases (Req 7.3).
  'customers:list': ALL_ROLES,
  'customers:count': ALL_ROLES,
  'customers:upsert': ALL_ROLES,
  'customers:detail': ALL_ROLES,

  // ----- Suppliers --------------------------------------------------------
  // Supplier directory is purchasing-side only (Req 6.x, 8.2).
  'suppliers:list': ADMIN_ONLY,
  'suppliers:count': ADMIN_ONLY,
  'suppliers:upsert': ADMIN_ONLY,
  'suppliers:detail': ADMIN_ONLY,

  // ----- Audit log (Admin only) -------------------------------------------
  'audit:list': ADMIN_ONLY,
  'audit:count': ADMIN_ONLY,

  // ----- Journal entries (Admin debug) ------------------------------------
  'journal_entries:list': ADMIN_ONLY,
  'journal_entries:count': ADMIN_ONLY,

  // ----- Reports ----------------------------------------------------------
  // Sales/top-selling/exports are reporting tools (Req 8.2, 9.x).
  // The low-stock list backs the persistent banner so cashiers can open it.
  'reports:dailySales': ADMIN_ONLY,
  'reports:monthlySales': ADMIN_ONLY,
  'reports:lowStock': ALL_ROLES,
  'reports:topSelling': ADMIN_ONLY,
  'reports:export': ADMIN_ONLY,

  // ----- Backup -----------------------------------------------------------
  'backup:now': ADMIN_ONLY,
  'backup:restore': ADMIN_ONLY,
  'backup:list': ADMIN_ONLY,

  // ----- Users & roles (Admin only) ---------------------------------------
  'users:list': ADMIN_ONLY,
  'users:upsert': ADMIN_ONLY,
  'users:assignRole': ADMIN_ONLY,

  // ----- Settings ---------------------------------------------------------
  // Reads are needed to render UI (e.g. shop info on receipts); writes are
  // Admin-only (Req 8.2, 8.3).
  'settings:get': ALL_ROLES,
  'settings:set': ADMIN_ONLY,

  // ----- Printer ----------------------------------------------------------
  // Test-print is reachable from the printer settings page (task 8.6) and
  // the page itself is Admin-only. RBAC denial for the Cashier role writes
  // an `rbac.deny` audit row before the handler runs (Req 8.4).
  'printer:test': ADMIN_ONLY,
});

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Frozen list of every channel name. Computed once at module load so test
 * suites and the router can iterate without re-walking `Object.keys` each
 * call. Cast is safe: the keys of `RBAC` are exactly `keyof IpcContract`
 * by construction.
 */
const CHANNELS: readonly IpcChannel[] = Object.freeze(Object.keys(RBAC) as IpcChannel[]);

/**
 * Permission helper consumed by the IPC router middleware (task 2.4) and
 * by the matrix exhaustiveness test (task 2.8).
 */
export const Permission = {
  /**
   * Returns `true` iff the given role may invoke the given channel.
   *
   * Lookup is `O(1)`; the matrix is a frozen object literal so this is a
   * single property read followed by an array `includes`.
   */
  allows(role: SessionRole, channel: IpcChannel): boolean {
    return RBAC[channel].includes(role);
  },

  /**
   * Returns the full list of channel names. Order matches the RBAC matrix
   * declaration order. The returned array is shared and frozen — callers
   * MUST NOT mutate it.
   */
  channels(): readonly IpcChannel[] {
    return CHANNELS;
  },
} as const;
