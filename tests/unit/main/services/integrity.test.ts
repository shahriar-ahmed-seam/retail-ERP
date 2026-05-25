/**
 * Unit tests for `runIntegrityCheck` (Phase 11, task 11.6).
 *
 * Drives the helper against an in-memory mock of the Prisma
 * `$queryRawUnsafe` surface. SQLite's `PRAGMA integrity_check`
 * returns one or more rows containing the literal `'ok'` when the
 * database is healthy; tests cover the healthy path, a non-`'ok'`
 * row (corruption detected), an empty result set (treated as
 * unhealthy), a non-string row (defensive), and a thrown error
 * (treated as `INTERNAL`).
 *
 * Validates: Requirements 10.6, 11.3, 16.8.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runIntegrityCheck,
  resetIntegrityPrisma,
  setIntegrityPrisma,
  type IntegrityPrismaLike,
} from '@main/services/integrity';

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

interface StubState {
  rows: Record<string, unknown>[] | (() => Record<string, unknown>[]);
  rawError: Error | null;
  calls: string[];
}

function createStub(): { stub: IntegrityPrismaLike; state: StubState } {
  const state: StubState = {
    rows: [{ integrity_check: 'ok' }],
    rawError: null,
    calls: [],
  };
  const stub: IntegrityPrismaLike = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async $queryRawUnsafe<T>(query: string): Promise<T> {
      state.calls.push(query);
      if (state.rawError !== null) throw state.rawError;
      const rows = typeof state.rows === 'function' ? state.rows() : state.rows;
      return rows as unknown as T;
    },
  };
  return { stub, state };
}

let stub: IntegrityPrismaLike;
let state: StubState;

beforeEach(() => {
  const created = createStub();
  stub = created.stub;
  state = created.state;
  setIntegrityPrisma(stub);
});

afterEach(() => {
  resetIntegrityPrisma();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runIntegrityCheck', () => {
  it('returns Ok({ ok: true }) when every row reports "ok"', async () => {
    state.rows = [{ integrity_check: 'ok' }];
    const result = await runIntegrityCheck();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ok).toBe(true);
    }
  });

  it('issues PRAGMA integrity_check exactly once', async () => {
    await runIntegrityCheck();
    expect(state.calls).toEqual(['PRAGMA integrity_check;']);
  });

  it('returns Ok({ ok: false, details }) when a row reports a corruption message', async () => {
    state.rows = [{ integrity_check: '*** in database main ***' }];
    const result = await runIntegrityCheck();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ok).toBe(false);
      if (!result.value.ok) {
        expect(result.value.details).toContain('*** in database main ***');
      }
    }
  });

  it('joins multiple corruption messages into the details payload', async () => {
    state.rows = [
      { integrity_check: 'row 1 broken' },
      { integrity_check: 'row 2 broken' },
    ];
    const result = await runIntegrityCheck();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ok).toBe(false);
      if (!result.value.ok) {
        expect(result.value.details).toContain('row 1 broken');
        expect(result.value.details).toContain('row 2 broken');
      }
    }
  });

  it('treats an empty result set as unhealthy', async () => {
    state.rows = [];
    const result = await runIntegrityCheck();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ok).toBe(false);
    }
  });

  it('returns Ok({ ok: false }) when a row has no string column', async () => {
    state.rows = [{ unrecognized: 42 }];
    const result = await runIntegrityCheck();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ok).toBe(false);
    }
  });

  it('tolerates the column being aliased to a different name', async () => {
    state.rows = [{ output: 'ok' }];
    const result = await runIntegrityCheck();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ok).toBe(true);
    }
  });

  it('returns Err(INTERNAL) when the PRAGMA call throws', async () => {
    state.rawError = new Error('connection closed');
    const result = await runIntegrityCheck();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      const details = result.error.details as { reason?: string; cause?: string };
      expect(details.reason).toBe('integrity_check_failed');
      expect(details.cause).toContain('connection closed');
    }
  });
});
