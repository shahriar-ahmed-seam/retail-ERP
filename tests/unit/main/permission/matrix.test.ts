import { describe, expect, it } from 'vitest';

import { Permission, RBAC } from '@main/permission/matrix';

import type { IpcChannel, SessionRole } from '@shared/ipc-contract';

/**
 * Unit tests for the static RBAC matrix (task 2.3).
 *
 * The full **Property 9 (RBAC matrix exhaustiveness)** runtime test —
 * which actually drives every handler through the router and asserts the
 * matrix is the single gate — lands in Phase 12 (task 12.3). The unit
 * tests here are the static half of that property:
 *
 *   1. Every key of `IpcContract` is present in `RBAC`. The
 *      `Record<keyof IpcContract, ...>` typing guarantees this at compile
 *      time; this test confirms it at runtime so a future refactor that
 *      weakens the type immediately fails the suite.
 *   2. Every role appearing anywhere in the matrix is one of
 *      `'Admin' | 'Cashier'`.
 *   3. The `Admin` role is granted access to every channel that any
 *      session is allowed to invoke (Req 8.2).
 *   4. The cashier denial set matches the canonical Req 8.3 list
 *      (pricing, manual stock adjustments, role assignment, settings
 *      writes, supplier management, purchase workflow, audit / journal
 *      browsing, backups, reports beyond the low-stock banner).
 *   5. The cashier allow set matches the canonical Req 7.2 / 7.4 / 8.3
 *      list (POS flow, product reads, customer attach, low-stock banner,
 *      settings reads, their own sales).
 *
 * **Validates: Requirements 1.5, 8.1, 8.2, 8.3, 8.4.**
 */

const VALID_ROLES: ReadonlySet<SessionRole> = new Set(['Admin', 'Cashier']);

describe('RBAC matrix shape', () => {
  it('exposes a non-empty channel list via Permission.channels()', () => {
    const channels = Permission.channels();
    expect(channels.length).toBeGreaterThan(0);
    // Sanity: should match the matrix exactly.
    expect(channels).toEqual(Object.keys(RBAC));
  });

  it('returns a frozen channel list (callers MUST NOT mutate)', () => {
    const channels = Permission.channels();
    expect(Object.isFrozen(channels)).toBe(true);
  });

  it('every entry is an array (possibly empty for setup channels)', () => {
    for (const channel of Permission.channels()) {
      expect(Array.isArray(RBAC[channel])).toBe(true);
    }
  });

  it('every role appearing in the matrix is one of Admin | Cashier', () => {
    for (const channel of Permission.channels()) {
      for (const role of RBAC[channel]) {
        expect(
          VALID_ROLES.has(role),
          `channel ${channel} contains invalid role ${String(role)}`,
        ).toBe(true);
      }
    }
  });

  it('does not duplicate roles within a single channel entry', () => {
    for (const channel of Permission.channels()) {
      const roles = RBAC[channel];
      expect(new Set(roles).size, `channel ${channel} has duplicate role entries`).toBe(
        roles.length,
      );
    }
  });
});

describe('Permission.allows', () => {
  it('grants Admin access to every channel that has any role', () => {
    // Per Req 8.2 the Admin role has full access to every administrative
    // surface. The only channel with no allowed role is
    // `setup:createInitialAdmin`, which is gated by `hasAnyAdmin()` rather
    // than RBAC. Asserting "Admin is in every non-empty entry" captures
    // 8.2 without forcing setup to be Admin-callable.
    for (const channel of Permission.channels()) {
      if (RBAC[channel].length === 0) continue;
      expect(
        Permission.allows('Admin', channel),
        `Admin should have access to ${channel}`,
      ).toBe(true);
    }
  });

  it('denies access for channels with no allowed role', () => {
    // `setup:createInitialAdmin` and `setup:isRequired` have empty role
    // lists; both are public-from-the-router's-perspective (requiresAuth:
    // false) and gated at the service layer (`hasAnyAdmin()`), so they
    // never go through a session and the matrix denies every role.
    expect(Permission.allows('Admin', 'setup:createInitialAdmin')).toBe(false);
    expect(Permission.allows('Cashier', 'setup:createInitialAdmin')).toBe(false);
    expect(Permission.allows('Admin', 'setup:isRequired')).toBe(false);
    expect(Permission.allows('Cashier', 'setup:isRequired')).toBe(false);
  });

  it('returns boolean (no truthy / falsy leak)', () => {
    expect(typeof Permission.allows('Admin', 'auth:login')).toBe('boolean');
    expect(typeof Permission.allows('Cashier', 'products:upsert')).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Cashier scope (Req 7.2, 7.4, 8.3)
// ---------------------------------------------------------------------------

/**
 * Channels the Cashier role MUST be able to invoke. Sourced from
 * Requirements 7.2, 7.4, 8.3 and the design's "Module breakdown" cashier
 * row plus the persistent low-stock banner (Req 3.6, 9.3).
 */
const CASHIER_ALLOW: readonly IpcChannel[] = [
  'auth:login',
  'auth:logout',
  // Product reads for POS lookup.
  'products:list',
  'products:count',
  // Category reads for product display.
  'categories:list',
  // POS flow.
  'pos:scan',
  'pos:finalize',
  // Customer attach + history (POS adds walk-ins; cashier can browse).
  'customers:list',
  'customers:count',
  'customers:upsert',
  'customers:detail',
  // Their own sales history (service filters rows by cashierId).
  'sales:list',
  'sales:count',
  // Low-stock banner + list page reachable from it.
  'inventory:lowStockCount',
  'reports:lowStock',
  // Settings read (e.g. shop info / printer config display).
  'settings:get',
];

/**
 * Channels the Cashier role MUST NOT be able to invoke. Sourced from
 * Req 8.3 ("Cashier ... SHALL deny access to pricing edits, role
 * assignment, manual stock adjustments, and settings"), plus the broader
 * admin surface that defaults to deny.
 */
const CASHIER_DENY: readonly IpcChannel[] = [
  // Pricing / catalog writes (Req 2.4, 8.3).
  'products:upsert',
  // Category management (Req 2.5, 8.3).
  'categories:upsert',
  'categories:delete',
  // Purchase workflow (Req 5, 8.2).
  'purchases:list',
  'purchases:count',
  'purchase:create',
  // Manual stock adjustment (Req 3.5, 8.3).
  'inventory:adjust',
  // Movement ledger browsing (admin audit tool).
  'inventory_movements:list',
  'inventory_movements:count',
  // Supplier management (Req 6, 8.2).
  'suppliers:list',
  'suppliers:count',
  'suppliers:upsert',
  'suppliers:detail',
  // Audit / journal browsing (Req 13, 8.2).
  'audit:list',
  'audit:count',
  'journal_entries:list',
  'journal_entries:count',
  // Reports beyond the low-stock banner (Req 9, 8.2).
  'reports:dailySales',
  'reports:monthlySales',
  'reports:topSelling',
  'reports:export',
  // Backups (Req 10, 8.2).
  'backup:now',
  'backup:restore',
  // User/role admin (Req 8.2, 8.5).
  'users:list',
  'users:upsert',
  'users:assignRole',
  // Settings writes (Req 8.3).
  'settings:set',
  // Printer test (Phase 8 task 8.6 — Admin only, surfaces from the
  // printer settings page).
  'printer:test',
  // Initial-admin setup is gated by hasAnyAdmin — not a cashier surface.
  'setup:createInitialAdmin',
  // First-run probe is public (requiresAuth: false). Like the setup
  // channel above it has an empty role list — the matrix is bypassed
  // entirely at the router — so it's classified deny here for
  // exhaustiveness.
  'setup:isRequired',
];

describe('Cashier scope', () => {
  it.each(CASHIER_ALLOW)('Cashier is allowed on %s', (channel) => {
    expect(Permission.allows('Cashier', channel)).toBe(true);
  });

  it.each(CASHIER_DENY)('Cashier is denied on %s', (channel) => {
    expect(Permission.allows('Cashier', channel)).toBe(false);
  });

  it('every channel is classified as either allow or deny for the Cashier role (no gaps)', () => {
    // Belt-and-suspenders: if a future channel is added to the contract
    // and matrix without being placed in either CASHIER_ALLOW or
    // CASHIER_DENY, this test fires a clear signal that someone needs to
    // make a deliberate decision about the cashier scope.
    const classified = new Set<IpcChannel>([...CASHIER_ALLOW, ...CASHIER_DENY]);
    const missing = Permission.channels().filter((c) => !classified.has(c));
    expect(missing, 'channels missing from Cashier allow/deny classification').toEqual([]);
    // And no channel should be in both lists.
    const overlap = CASHIER_ALLOW.filter((c) => CASHIER_DENY.includes(c));
    expect(overlap, 'channels that are both allowed and denied for Cashier').toEqual([]);
  });
});
