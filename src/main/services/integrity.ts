// src/main/services/integrity.ts
//
// SQLite integrity-check helper for the recovery flow (Phase 11,
// task 11.6).
//
// Responsibility: drive `PRAGMA integrity_check` against the live
// database connection and surface a structured result to the
// startup recovery prompt. SQLite's `integrity_check` returns a
// single row containing the literal `'ok'` when the database is
// healthy; on damage it returns one or more rows describing each
// detected problem (per the SQLite docs, the output is a list of
// strings — the call returns `'ok'` iff the database has no
// detected corruption).
//
// We use `$queryRawUnsafe` rather than `$executeRawUnsafe` because
// PRAGMAs that surface result rows (`integrity_check` is one)
// throw "Execute returned results, which is not allowed in SQLite"
// through the `executeRaw` family. The PRAGMA name is a
// module-level literal (not user input) so the unsafe variant is
// the right tool here.
//
// The helper is deliberately Result-typed so callers (the startup
// bootstrap in `src/main/index.ts`, plus future settings-page
// integrations) never have to wrap a try/catch around it.
//
// Validates: Requirements 10.6, 11.3, 16.8.

import { prisma as defaultPrisma } from '@main/db/prisma.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Successful return shape. The discriminator `ok: true | false` lives
 * inside the `value` of the outer `Result` envelope so callers can
 * pattern-match on the integrity verdict separately from any infrastructure
 * error.
 */
export type IntegrityCheckOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly details: string };

/**
 * Subset of the Prisma surface this module touches. Declared
 * structurally so tests can drive the helper against an in-memory
 * stub without dragging the real client in.
 */
export interface IntegrityPrismaLike {
  $queryRawUnsafe<T>(query: string): Promise<T>;
}

// ---------------------------------------------------------------------------
// Dependency injection seam (test-only)
// ---------------------------------------------------------------------------

let activePrisma: IntegrityPrismaLike = defaultPrisma;

/** Replace the active Prisma client. Used only by tests. */
export function setIntegrityPrisma(client: IntegrityPrismaLike): void {
  activePrisma = client;
}

/** Restore the production Prisma client. Convenience for tests' `afterEach`. */
export function resetIntegrityPrisma(): void {
  activePrisma = defaultPrisma;
}

// ---------------------------------------------------------------------------
// runIntegrityCheck
// ---------------------------------------------------------------------------

/**
 * Run `PRAGMA integrity_check` against the live SQLite connection.
 *
 * SQLite returns one or more rows; the database is healthy iff every
 * row's payload column equals the literal string `'ok'`. The column
 * name in the result set is `integrity_check` (matches the PRAGMA
 * name); we tolerate any column name by reading the first string
 * value off each row to keep the helper robust against minor driver
 * differences.
 *
 * Returns:
 *   - `Ok({ ok: true })` — every row was `'ok'`.
 *   - `Ok({ ok: false, details })` — at least one row was non-`'ok'`;
 *     `details` carries the joined message strings so the recovery
 *     prompt can show the operator what SQLite found.
 *   - `Err('INTERNAL', { reason: 'integrity_check_failed' })` — the
 *     PRAGMA itself threw (e.g. the connection is closed, the file
 *     was deleted out from under us). Treated as "database broken,
 *     recover" by the bootstrap caller.
 *
 * Validates: Requirements 10.6, 11.3, 16.8.
 */
export async function runIntegrityCheck(): Promise<Result<IntegrityCheckOutcome>> {
  try {
    const rows = await activePrisma.$queryRawUnsafe<Record<string, unknown>[]>(
      'PRAGMA integrity_check;',
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      // An empty result set is unexpected (SQLite always returns at
      // least one row); treat it as a corruption signal so the
      // recovery flow runs.
      return Ok({ ok: false, details: 'integrity_check returned no rows' });
    }

    const messages: string[] = [];
    let allOk = true;
    for (const row of rows) {
      // The single column is named `integrity_check`. Defensively
      // read the first string value off the row so we tolerate a
      // future driver that changes the column alias.
      let payload: string | null = null;
      if (typeof row === 'object' && row !== null) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string') {
            payload = value;
            break;
          }
        }
      }
      if (payload === null) {
        allOk = false;
        messages.push('non-string row');
        continue;
      }
      if (payload !== 'ok') {
        allOk = false;
        messages.push(payload);
      }
    }

    if (allOk) return Ok({ ok: true });
    return Ok({ ok: false, details: messages.join('; ') });
  } catch (err) {
    return Err('INTERNAL', {
      reason: 'integrity_check_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Integrity service surface. Exposed as a frozen object literal for
 * symmetry with every other service in this folder. Production code
 * imports `runIntegrityCheck` directly; the namespace exists so
 * future helpers (e.g. `runQuickCheck`, `runForeignKeyCheck`) plug
 * in without changing the call site.
 */
export const IntegrityService = Object.freeze({
  runIntegrityCheck,
} as const);

// `PrismaClient` re-exported as a type so handler-side code can
// reference it without a separate import path. Not part of the wire
// surface.
export type { PrismaClient };
