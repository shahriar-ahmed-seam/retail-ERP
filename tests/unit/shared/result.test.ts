import { describe, expect, it } from 'vitest';

import {
  Err,
  Ok,
  UnwrapError,
  isErr,
  isOk,
  match,
  unwrap,
  type ErrorEnvelope,
  type Result,
} from '@shared/result';

/**
 * Unit tests for the shared `Result<T, E>` envelope (task 2.1).
 *
 * These cover the public surface used by every IPC handler:
 *   - `Ok` / `Err` constructors
 *   - `isOk` / `isErr` type guards
 *   - `unwrap` (success + throwing branch)
 *   - `match` exhaustive pattern match
 *
 * Validates the design.md "Result envelope" contract that underpins
 * Requirements 1.2, 3.7, 4.8, 4.9, 5.5, 8.4, 15.1.
 */

describe('Ok', () => {
  it('wraps a value into a successful Result', () => {
    const result = Ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('preserves complex values without copying', () => {
    const value = { id: 'p1', qty: 3 };
    const result = Ok(value);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(value);
    }
  });
});

describe('Err', () => {
  it('builds an envelope with the default message for the code', () => {
    const result = Err('FORBIDDEN');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.message).toMatch(/permission/i);
      expect(result.error.details).toBeUndefined();
      expect(result.error.errorId).toBeUndefined();
    }
  });

  it('attaches details verbatim (matches design.md FORBIDDEN audit example)', () => {
    const result = Err('FORBIDDEN', { auditDenial: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toEqual({ auditDenial: true });
    }
  });

  it('supports the OUT_OF_STOCK shape used by the sale-finalize tx', () => {
    const result = Err('OUT_OF_STOCK', { productId: 'p1' });
    if (!result.ok) {
      expect(result.error.code).toBe('OUT_OF_STOCK');
      expect(result.error.details).toEqual({ productId: 'p1' });
    }
  });

  it('honours an overridden message', () => {
    const result = Err('VALIDATION', { field: 'email' }, { message: 'Email is required' });
    if (!result.ok) {
      expect(result.error.message).toBe('Email is required');
      expect(result.error.details).toEqual({ field: 'email' });
    }
  });

  it('attaches errorId for INTERNAL correlation', () => {
    const result = Err('INTERNAL', undefined, { errorId: 'abc-123' });
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.errorId).toBe('abc-123');
      expect(result.error.details).toBeUndefined();
    }
  });

  it.each([
    'VALIDATION',
    'OUT_OF_STOCK',
    'UNIQUE_VIOLATION',
    'FK_VIOLATION',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'PRINTER_FAILURE',
    'DB_INTEGRITY',
    'INTERNAL',
  ] as const)('produces a non-empty default message for %s', (code) => {
    const result = Err(code);
    if (!result.ok) {
      expect(result.error.code).toBe(code);
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('isOk / isErr', () => {
  it('isOk narrows to OkResult', () => {
    const result: Result<number> = Ok(7);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (isOk(result)) {
      // Type-level: result.value is now `number`.
      expect(result.value + 1).toBe(8);
    }
  });

  it('isErr narrows to ErrResult', () => {
    const result: Result<number> = Err('VALIDATION');
    expect(isErr(result)).toBe(true);
    expect(isOk(result)).toBe(false);
    if (isErr(result)) {
      // Type-level: result.error is now `ErrorEnvelope`.
      expect(result.error.code).toBe('VALIDATION');
    }
  });
});

describe('unwrap', () => {
  it('returns the success value', () => {
    expect(unwrap(Ok('hello'))).toBe('hello');
  });

  it('throws UnwrapError carrying the envelope when called on Err', () => {
    const result = Err('UNAUTHENTICATED');
    let caught: unknown;
    try {
      unwrap(result);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnwrapError);
    if (caught instanceof UnwrapError) {
      const error = caught.error as ErrorEnvelope;
      expect(error.code).toBe('UNAUTHENTICATED');
      expect(caught.message).toContain('UNAUTHENTICATED');
    }
  });
});

describe('match', () => {
  it('routes to the ok handler for successful results', () => {
    const result: Result<number> = Ok(10);
    const doubled = match(result, {
      ok: (v) => v * 2,
      err: () => -1,
    });
    expect(doubled).toBe(20);
  });

  it('routes to the err handler for failing results', () => {
    const result: Result<number> = Err('VALIDATION', { field: 'qty' });
    const code = match(result, {
      ok: () => 'ok',
      err: (e) => e.code,
    });
    expect(code).toBe('VALIDATION');
  });

  it('keeps both branches type-compatible (return value flows through)', () => {
    // Mirrors how the renderer's error mapper will collapse a result into a
    // toast-or-render decision.
    const render = (r: Result<{ id: string }>): string =>
      match(r, {
        ok: (v) => `id=${v.id}`,
        err: (e) => `error=${e.code}`,
      });
    expect(render(Ok({ id: 's-1' }))).toBe('id=s-1');
    expect(render(Err('FK_VIOLATION', { supplierId: 'missing' }))).toBe('error=FK_VIOLATION');
  });
});
