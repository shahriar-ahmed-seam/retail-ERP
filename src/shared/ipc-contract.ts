/**
 * Single source of truth for every IPC channel between the renderer and the
 * main process.
 *
 * `IpcContract` is a TypeScript-only artifact: it never runs, it only types
 * the request and response shapes per channel. The same module is imported
 * by:
 *
 *   - the main-process router (`src/main/ipc/router.ts`, task 2.4) so each
 *     handler is required to match `IpcContract[channel]['res']`,
 *   - the preload bridge (`src/preload/index.ts`, task 2.6) so it exposes
 *     exactly one method per channel via `contextBridge`,
 *   - the renderer typed wrapper (`src/renderer/lib/api.ts`, task 2.7) so
 *     the UI cannot call a channel that does not exist or pass the wrong
 *     payload, and
 *   - the RBAC matrix (`src/main/permission/matrix.ts`, task 2.3) which
 *     uses `keyof IpcContract` as its key set so adding a channel without
 *     declaring its allowed roles is a type error.
 *
 * Every paginated list channel listed below uses the {@link ListRequest} /
 * {@link ListResponse} envelope. Every count channel uses
 * `{ filter?, search? }` → `{ totalCount: number }`. Both invariants are
 * spelled out in design.md > "List channel pagination contract" and are
 * the foundation for the < 100 ms p95 first-page target on million-row
 * tables (Req 16.9, Property 16).
 *
 * Validates: Requirements 1.1, 1.5, 2.1, 4, 5, 6, 7, 8, 9, 10, 13, 15.1,
 *            16.1, 16.2, 16.3.
 */

import type {
  AdjustmentInput,
  AuditFilter,
  AuditLogDTO,
  AuditSortKey,
  CategoryDTO,
  CategoryInput,
  CustomerDTO,
  CustomerFilter,
  CustomerInput,
  CustomerSortKey,
  FinalizeSaleInput,
  InventoryMovementDTO,
  JournalEntryDTO,
  JournalFilter,
  JournalSortKey,
  MovementFilter,
  MovementSortKey,
  ProductDTO,
  ProductFilter,
  ProductInput,
  ProductSortKey,
  PurchaseInput,
  PurchaseSummaryDTO,
  PurchasesFilter,
  PurchasesSortKey,
  SaleDTO,
  SaleSummaryDTO,
  SalesFilter,
  SalesSortKey,
  SupplierDTO,
  SupplierFilter,
  SupplierInput,
  SupplierSortKey,
} from './dto/index.js';
import type { Result } from './result.js';

// ---------------------------------------------------------------------------
// Pagination envelope (Req 16.1, 16.2, 16.3)
// ---------------------------------------------------------------------------

/**
 * Generic request envelope used by every paginated list channel.
 *
 * `F` is the per-channel filter shape (e.g. `ProductFilter`); `S` is the
 * union of allowed sort keys for that channel. Both are constrained by
 * the channel's TypeScript declaration so a renderer cannot ask for an
 * unindexed sort key — the request would fail to typecheck.
 *
 * The cursor is opaque (`base64(JSON({ ts, id }))`) and is produced by the
 * main process from the last row of the previous page. `pageSize` defaults
 * to 50 server-side; the hard maximum of 200 is clamped server-side
 * regardless of what the renderer sends. `withCount` is opt-in because
 * SQLite has no btree row-count metadata, so `COUNT(*)` is `O(N)` even on
 * indexed columns.
 */
export interface ListRequest<F, S extends string> {
  filter?: F;
  /** Server-side normalized prefix `LIKE` against the channel's primary
   *  search column (see design.md > "Server-side filter, search, sort"). */
  search?: string;
  sort?: { key: S; dir: 'asc' | 'desc' };
  /** Opaque base64(JSON) cursor from the previous page; omit on first page. */
  cursor?: string;
  /** Default 50, clamped to `[1, 200]` server-side. */
  pageSize?: number;
  /** Opt-in `COUNT(*)`; otherwise `totalCount` is omitted from the response. */
  withCount?: boolean;
}

/**
 * Generic response envelope. `nextCursor` is `null` exactly when the page
 * completes the result set (i.e. `rows.length < pageSize`). `totalCount`
 * is present iff the request set `withCount: true`.
 */
export interface ListResponse<T> {
  rows: readonly T[];
  nextCursor: string | null;
  totalCount?: number;
}

// ---------------------------------------------------------------------------
// Auxiliary inline types
// ---------------------------------------------------------------------------
// Types that aren't first-class DTOs (no list/cursor presence) live here so
// the dto/ folder stays focused on the per-table cross-process shapes.

/** Session role discriminator returned by `auth:login` and friends. */
export type SessionRole = 'Admin' | 'Cashier';

/** Session record returned to the renderer on login / setup. */
export interface SessionDTO {
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly role: SessionRole;
}

/** User row returned by `users:list`, `users:upsert`, `users:assignRole`. */
export interface UserDTO {
  readonly id: string;
  readonly username: string;
  readonly roleId: string;
  readonly roleName: SessionRole;
  readonly createdAt: string;
}

/**
 * Request payload for `users:upsert`. `password` is required on create,
 * optional on update — the handler treats an absent `password` as
 * "unchanged". Sending `password` on update re-hashes via bcrypt.
 */
export interface UserUpsertInput {
  readonly id?: string;
  readonly username: string;
  readonly password?: string;
  readonly roleId: string;
}

/** Daily sales report result (Req 9.1). */
export interface DailySalesReport {
  readonly date: string;
  readonly salesCount: number;
  readonly totalRevenue: string;
  readonly totalTax: string;
  readonly totalDiscount: string;
  readonly paymentBreakdown: readonly {
    readonly method: 'cash' | 'card' | 'mobile';
    readonly amount: string;
  }[];
}

/** Monthly sales report result (Req 9.2). */
export interface MonthlySalesReport {
  /** Month identifier in `YYYY-MM` form. */
  readonly month: string;
  readonly salesCount: number;
  readonly totalRevenue: string;
  readonly totalTax: string;
  readonly totalDiscount: string;
}

/** Single row of the low-stock report (Req 9.3). */
export interface LowStockRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly onHand: number;
  readonly reorderLevel: number;
}

/** Single row of the top-selling report (Req 9.4). */
export interface TopSellingRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly unitsSold: number;
  readonly revenue: string;
}

/**
 * Request payload for `reports:export`. The `reportId` chooses which
 * report to render; `filter` and `sort` are forwarded into the underlying
 * cursor-paginated `SELECT` (design.md > "Streaming exports").
 */
export interface ReportExportRequest {
  readonly reportId: 'dailySales' | 'monthlySales' | 'lowStock' | 'topSelling';
  readonly format: 'csv' | 'pdf';
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly sort?: { readonly key: string; readonly dir: 'asc' | 'desc' };
}

/** A persisted setting value (always JSON-decoded by main before send). */
export type SettingValue = unknown;

// ---------------------------------------------------------------------------
// IpcContract
// ---------------------------------------------------------------------------

/**
 * Mapping from channel name → request and response types.
 *
 * Channel naming convention (mirrors design.md):
 *   - `<entity>:list`    → paginated list, `ListRequest`/`ListResponse` envelope.
 *   - `<entity>:count`   → `{ filter?, search? }` → `{ totalCount }`.
 *   - `<entity>:upsert`  → create-or-update, returns the resulting DTO.
 *   - `<entity>:detail`  → single record + any per-record paginated history.
 *   - `<verb>:<noun>`    → for action-style channels (e.g. `pos:finalize`).
 */
export interface IpcContract {
  // ----- Auth & first-run setup -------------------------------------------
  'auth:login': {
    req: { username: string; password: string };
    res: SessionDTO;
  };
  'auth:logout': {
    req: void;
    res: void;
  };
  'setup:createInitialAdmin': {
    req: { username: string; password: string };
    res: SessionDTO;
  };
  /**
   * First-run gate consulted by the renderer on every app start
   * (`src/renderer/features/setup/SetupPage.tsx`, task 3.4). Returns
   * `{ required: true }` iff no Admin user exists in the database, in
   * which case the renderer routes to the setup screen before the login
   * page is reachable. The channel is public (`requiresAuth: false`) and
   * has no side effects — it is a thin wrapper around
   * `AuthService.hasAnyAdmin()`.
   *
   * Validates: Requirements 1.6, 14.2.
   */
  'setup:isRequired': {
    req: void;
    res: { required: boolean };
  };

  // ----- Products ---------------------------------------------------------
  'products:list': {
    req: ListRequest<ProductFilter, ProductSortKey>;
    res: ListResponse<ProductDTO>;
  };
  'products:count': {
    req: { filter?: ProductFilter; search?: string };
    res: { totalCount: number };
  };
  'products:upsert': {
    req: ProductInput;
    res: ProductDTO;
  };

  // ----- Categories -------------------------------------------------------
  // Small reference table — not paginated. Cashiers may read for product
  // display; only Admin manages catalog (Req 2.5, 8.3).
  'categories:list': {
    req: void;
    res: { rows: readonly CategoryDTO[] };
  };
  'categories:upsert': {
    req: CategoryInput;
    res: CategoryDTO;
  };
  'categories:delete': {
    req: { id: string };
    res: void;
  };

  // ----- POS --------------------------------------------------------------
  'pos:scan': {
    req: { barcode: string };
    res: ProductDTO | null;
  };
  'pos:finalize': {
    req: FinalizeSaleInput;
    res: { saleId: string; serialNo: string; sale: SaleDTO };
  };

  // ----- Purchases --------------------------------------------------------
  'purchases:list': {
    req: ListRequest<PurchasesFilter, PurchasesSortKey>;
    res: ListResponse<PurchaseSummaryDTO>;
  };
  'purchases:count': {
    req: { filter?: PurchasesFilter; search?: string };
    res: { totalCount: number };
  };
  'purchase:create': {
    req: PurchaseInput;
    res: { purchaseId: string };
  };

  // ----- Inventory --------------------------------------------------------
  'inventory:adjust': {
    req: AdjustmentInput;
    res: { movementId: string };
  };
  'inventory:lowStockCount': {
    req: void;
    res: { count: number };
  };
  'inventory_movements:list': {
    req: ListRequest<MovementFilter, MovementSortKey>;
    res: ListResponse<InventoryMovementDTO>;
  };
  'inventory_movements:count': {
    req: { filter?: MovementFilter; search?: string };
    res: { totalCount: number };
  };

  // ----- Sales (read-only history) ----------------------------------------
  'sales:list': {
    req: ListRequest<SalesFilter, SalesSortKey>;
    res: ListResponse<SaleSummaryDTO>;
  };
  'sales:count': {
    req: { filter?: SalesFilter; search?: string };
    res: { totalCount: number };
  };

  // ----- Customers --------------------------------------------------------
  'customers:list': {
    req: ListRequest<CustomerFilter, CustomerSortKey>;
    res: ListResponse<CustomerDTO>;
  };
  'customers:count': {
    req: { filter?: CustomerFilter; search?: string };
    res: { totalCount: number };
  };
  'customers:upsert': {
    req: CustomerInput;
    res: CustomerDTO;
  };
  'customers:detail': {
    req: {
      id: string;
      history?: ListRequest<Record<string, never>, SalesSortKey>;
    };
    res: {
      customer: CustomerDTO;
      history: ListResponse<SaleSummaryDTO>;
    };
  };

  // ----- Suppliers --------------------------------------------------------
  'suppliers:list': {
    req: ListRequest<SupplierFilter, SupplierSortKey>;
    res: ListResponse<SupplierDTO>;
  };
  'suppliers:count': {
    req: { filter?: SupplierFilter; search?: string };
    res: { totalCount: number };
  };
  'suppliers:upsert': {
    req: SupplierInput;
    res: SupplierDTO;
  };
  'suppliers:detail': {
    req: {
      id: string;
      history?: ListRequest<Record<string, never>, PurchasesSortKey>;
    };
    res: {
      supplier: SupplierDTO;
      history: ListResponse<PurchaseSummaryDTO>;
    };
  };

  // ----- Audit log (Admin only) -------------------------------------------
  'audit:list': {
    req: ListRequest<AuditFilter, AuditSortKey>;
    res: ListResponse<AuditLogDTO>;
  };
  'audit:count': {
    req: { filter?: AuditFilter; search?: string };
    res: { totalCount: number };
  };

  // ----- Journal entries (Admin debug) ------------------------------------
  'journal_entries:list': {
    req: ListRequest<JournalFilter, JournalSortKey>;
    res: ListResponse<JournalEntryDTO>;
  };
  'journal_entries:count': {
    req: { filter?: JournalFilter; search?: string };
    res: { totalCount: number };
  };

  // ----- Reports ----------------------------------------------------------
  'reports:dailySales': {
    req: { date: string };
    res: DailySalesReport;
  };
  'reports:monthlySales': {
    /** `YYYY-MM` form. */
    req: { month: string };
    res: MonthlySalesReport;
  };
  'reports:lowStock': {
    req: void;
    res: { rows: readonly LowStockRow[] };
  };
  'reports:topSelling': {
    req: { dateFrom: string; dateTo: string; limit?: number };
    res: { rows: readonly TopSellingRow[] };
  };
  'reports:export': {
    req: ReportExportRequest;
    res: { path: string; rowCount: number };
  };

  // ----- Backup -----------------------------------------------------------
  'backup:now': {
    req: void;
    res: { path: string };
  };
  'backup:restore': {
    req: { path: string };
    res: void;
  };

  // ----- Users & roles (Admin only) ---------------------------------------
  'users:list': {
    req: void;
    res: { rows: readonly UserDTO[] };
  };
  'users:upsert': {
    req: UserUpsertInput;
    res: UserDTO;
  };
  'users:assignRole': {
    req: { userId: string; roleId: string };
    res: UserDTO;
  };

  // ----- Settings ---------------------------------------------------------
  'settings:get': {
    req: { key: string };
    res: { value: SettingValue };
  };
  'settings:set': {
    req: { key: string; value: SettingValue };
    res: void;
  };

  // ----- Printer (Admin only) ---------------------------------------------
  /**
   * Test-print a synthetic receipt through the live printer chain
   * (`selectPrinter().print(receipt)` — ESC/POS → HTML → PDF). The
   * Settings UI for printer configuration (Phase 8, task 8.6) calls
   * this after the operator picks a `kind` / `target` so they can
   * confirm the configured device actually emits paper before
   * finalizing a real sale. Admin-only — RBAC denies the Cashier
   * role and writes an `rbac.deny` audit row.
   *
   * The synthetic receipt carries the configured shop-info block (so
   * the operator can verify the header), the current timestamp, a
   * single placeholder line ("TEST PRINT"), zero totals, and no
   * payments. Nothing is persisted — `runChain` is invoked directly,
   * NOT `postCommitPrint`, so the test print is observable as
   * `Ok({ adapter })` carrying the link in the chain that handled
   * it (`'escpos' | 'html' | 'pdf'`). On chain-wide failure the
   * envelope is the LAST adapter's `Err('PRINTER_FAILURE', ...)`.
   *
   * Validates: Requirements 4.7, 8.2.
   */
  'printer:test': {
    req: void;
    res: { adapter: 'escpos' | 'html' | 'pdf'; output?: string };
  };
}

/** Convenience alias for any channel name. */
export type IpcChannel = keyof IpcContract;

/** Request shape for a given channel. */
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['req'];

/** Response shape for a given channel. */
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['res'];

// ---------------------------------------------------------------------------
// IPC_CHANNELS — runtime channel list
// ---------------------------------------------------------------------------

/**
 * Frozen runtime list of every IPC channel name. `IpcContract` itself is
 * a type-only artifact (zero runtime presence), so anything that needs to
 * iterate the channel set at runtime — chiefly the preload bridge
 * (`src/preload/index.ts`, task 2.6), the renderer typed API wrapper
 * (`src/renderer/lib/api.ts`, task 2.7), and the RBAC matrix
 * exhaustiveness test (task 2.8) — reads this list rather than rebuilding
 * it from `Object.keys(RBAC)` or hard-coding 41 method definitions.
 *
 * The exhaustiveness check below ties this constant to `IpcContract` at
 * compile time: declaring a new channel in `IpcContract` without adding
 * it here, or vice versa, surfaces as a `_check` type error on `npm run
 * typecheck`. This is the static counterpart to the runtime Property 9
 * matrix-coverage test.
 */
export const IPC_CHANNELS = [
  // Auth & first-run setup
  'auth:login',
  'auth:logout',
  'setup:createInitialAdmin',
  'setup:isRequired',

  // Products
  'products:list',
  'products:count',
  'products:upsert',

  // Categories
  'categories:list',
  'categories:upsert',
  'categories:delete',

  // POS
  'pos:scan',
  'pos:finalize',

  // Purchases
  'purchases:list',
  'purchases:count',
  'purchase:create',

  // Inventory
  'inventory:adjust',
  'inventory:lowStockCount',
  'inventory_movements:list',
  'inventory_movements:count',

  // Sales (read-only history)
  'sales:list',
  'sales:count',

  // Customers
  'customers:list',
  'customers:count',
  'customers:upsert',
  'customers:detail',

  // Suppliers
  'suppliers:list',
  'suppliers:count',
  'suppliers:upsert',
  'suppliers:detail',

  // Audit log
  'audit:list',
  'audit:count',

  // Journal entries
  'journal_entries:list',
  'journal_entries:count',

  // Reports
  'reports:dailySales',
  'reports:monthlySales',
  'reports:lowStock',
  'reports:topSelling',
  'reports:export',

  // Backup
  'backup:now',
  'backup:restore',

  // Users & roles
  'users:list',
  'users:upsert',
  'users:assignRole',

  // Settings
  'settings:get',
  'settings:set',

  // Printer
  'printer:test',
] as const satisfies readonly IpcChannel[];

/** Channel names declared in `IPC_CHANNELS`, derived back from the literal tuple. */
type DeclaredChannel = (typeof IPC_CHANNELS)[number];

/**
 * Compile-time exhaustiveness assertion. Both directions are checked:
 *
 *   - `Exclude<keyof IpcContract, DeclaredChannel>` is `never` iff every
 *     channel in `IpcContract` appears in `IPC_CHANNELS`.
 *   - `Exclude<DeclaredChannel, keyof IpcContract>` is `never` iff
 *     `IPC_CHANNELS` does not contain a stray name no longer in `IpcContract`.
 *
 * If either side is non-empty, the `true` literal cannot satisfy the
 * resulting `[message, MissingChannel]` tuple type and the line below
 * fails to typecheck — surfacing the missing/extra channel name in the
 * error message.
 */
type _ExhaustiveCheck =
  Exclude<keyof IpcContract, DeclaredChannel> extends never
    ? Exclude<DeclaredChannel, keyof IpcContract> extends never
      ? true
      : ['Extra channel in IPC_CHANNELS:', Exclude<DeclaredChannel, keyof IpcContract>]
    : ['Missing channel in IPC_CHANNELS:', Exclude<keyof IpcContract, DeclaredChannel>];

// `_check` is intentionally a value: a type error here is the signal
// developers see when they've drifted IPC_CHANNELS away from IpcContract.
// The `_` prefix opts it out of the unused-vars rule.
const _check: _ExhaustiveCheck = true;

// ---------------------------------------------------------------------------
// Api — renderer-facing surface
// ---------------------------------------------------------------------------

/**
 * Fully-typed `window.api` shape: one async method per IPC channel, each
 * returning `Promise<Result<IpcResponse<C>>>`. The preload bridge
 * (`src/preload/index.ts`, task 2.6) builds an object of this exact shape
 * by walking `IPC_CHANNELS` and delegating each method to
 * `ipcRenderer.invoke(channel, req)`.
 *
 * The renderer's global declaration in `src/renderer/types/window.d.ts`
 * augments `globalThis.Window` with `api: Api` so feature pages can call
 * `window.api['products:list'](...)` with full type-safety.
 *
 * Channels whose request type is `void` are exposed as zero-argument
 * methods — see the conditional below — so callers don't have to pass an
 * explicit `undefined`.
 */
export type Api = {
  [C in IpcChannel]: IpcRequest<C> extends void
    ? () => Promise<Result<IpcResponse<C>>>
    : (req: IpcRequest<C>) => Promise<Result<IpcResponse<C>>>;
};
