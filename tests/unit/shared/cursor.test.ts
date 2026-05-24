import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CursorDecodeError,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  type CursorInput,
  type CursorPayload,
} from '@shared/cursor';

/**
 * Unit tests for the shared cursor utility (task 2.11).
 *
 * Two properties are exercised here, plus targeted unit cases for
 * `clampPageSize` and a handful of named edge cases:
 *
 *   1. **Round-trip** — for any `{ ts: Date, id: string }`,
 *      `decodeCursor(encodeCursor(x))` deep-equals `x`. Validates that the
 *      cursor format is loss-less so list pagination can resume exactly
 *      where it left off (Requirement 16.1).
 *   2. **Tampering** — every malformed token category surfaces a
 *      `CursorDecodeError`. The IPC router (see `src/main/ipc/router.ts`)
 *      maps that tagged error to `Err('VALIDATION', { field: 'cursor' })`,
 *      so a single instance check here protects the whole list-channel
 *      contract (Requirement 16.3).
 *
 * fast-check is imported directly because the `unit` tier setup
 * (tests/unit/setup.ts) is intentionally empty; only the `property` tier
 * configures fast-check globals.
 *
 * **Validates: Requirements 16.1, 16.3.**
 */

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Non-empty `id` strings. Default-mode strings round-trip cleanly through
 * `JSON.stringify` + `TextEncoder`/`TextDecoder('utf-8', { fatal: true })`,
 * so this is enough to drive the cursor's full surface without dragging in
 * lone surrogates or other UTF-8 hazards that would distract the property
 * from what it's actually checking.
 */
const idArbitrary = fc.string({ minLength: 1, maxLength: 64 });

/**
 * Dates restricted to the canonical four-digit-year ISO range. fast-check's
 * default `fc.date` happily produces extended-year values (e.g. year
 * `-137874`), which `Date.toISOString()` and `new Date(iso)` do still
 * round-trip — but constraining to `0001..9999` keeps shrunk
 * counter-examples readable when something does break.
 */
const tsArbitrary = fc.date({
  min: new Date('0001-01-01T00:00:00.000Z'),
  max: new Date('9999-12-31T23:59:59.999Z'),
  noInvalidDate: true,
});

const cursorInputArbitrary = fc.record({
  ts: tsArbitrary,
  id: idArbitrary,
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('encodeCursor / decodeCursor round-trip', () => {
  it('property: decodeCursor(encodeCursor(x)) deep-equals x for arbitrary { ts: Date, id: string }', () => {
    fc.assert(
      fc.property(cursorInputArbitrary, ({ ts, id }) => {
        const decoded: CursorPayload = decodeCursor(encodeCursor({ ts, id }));
        // toEqual deep-compares Dates by their underlying time value, which
        // is exactly the equivalence the IPC list contract relies on.
        expect(decoded).toEqual({ ts, id });
        // Belt-and-suspenders: confirm the time value matches and the type
        // is still a Date (not a stringified ISO).
        expect(decoded.ts).toBeInstanceOf(Date);
        expect(decoded.ts.getTime()).toBe(ts.getTime());
        expect(decoded.id).toBe(id);
      }),
    );
  });

  it('accepts an ISO date string for ts and round-trips to the equivalent Date', () => {
    const iso = '2026-05-24T07:38:08.123Z';
    const input: CursorInput = { ts: iso, id: 'ckxy42abc0001' };
    const decoded = decodeCursor(encodeCursor(input));
    expect(decoded.ts).toBeInstanceOf(Date);
    expect(decoded.ts.toISOString()).toBe(iso);
    expect(decoded.id).toBe('ckxy42abc0001');
  });

  it('round-trips a far-future Date (year 9999)', () => {
    const ts = new Date('9999-12-31T23:59:59.999Z');
    const decoded = decodeCursor(encodeCursor({ ts, id: 'tail' }));
    expect(decoded).toEqual({ ts, id: 'tail' });
  });

  it('round-trips a CUID-like id (ASCII alnum, length 25)', () => {
    const ts = new Date('2026-01-01T00:00:00.000Z');
    const id = 'ckxy42abc0001def23ghij456';
    const decoded = decodeCursor(encodeCursor({ ts, id }));
    expect(decoded).toEqual({ ts, id });
  });

  it('round-trips a UUIDv4-shaped id', () => {
    const ts = new Date('2026-01-01T00:00:00.000Z');
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const decoded = decodeCursor(encodeCursor({ ts, id }));
    expect(decoded).toEqual({ ts, id });
  });
});

// ---------------------------------------------------------------------------
// Tampering
// ---------------------------------------------------------------------------

/**
 * Assert that a token decode raises a `CursorDecodeError` carrying the
 * stable `CURSOR_DECODE` tag. Any thrown `CursorDecodeError` will be
 * mapped by the IPC router to `Err('VALIDATION', { field: 'cursor' })`,
 * so the whole point of this helper is to lock in that class boundary.
 */
function expectCursorDecodeError(token: string): void {
  let caught: unknown;
  try {
    decodeCursor(token);
  } catch (e) {
    caught = e;
  }
  expect(caught, `decodeCursor(${JSON.stringify(token)}) should have thrown`).toBeInstanceOf(
    CursorDecodeError,
  );
  if (caught instanceof CursorDecodeError) {
    expect(caught.tag).toBe('CURSOR_DECODE');
    expect(caught.name).toBe('CursorDecodeError');
    expect(caught.message.length).toBeGreaterThan(0);
  }
}

/** Encode an arbitrary UTF-8 payload as base64 without going through encodeCursor. */
function rawBase64(payload: string): string {
  const bytes = new TextEncoder().encode(payload);
  let bin = '';
  for (const b of bytes) {
    bin += String.fromCharCode(b as number);
  }
  return btoa(bin);
}

describe('decodeCursor tampering', () => {
  describe('non-base64', () => {
    const fixedNonBase64: readonly string[] = [
      // Empty token is rejected by the explicit length check.
      '',
      // Characters outside the base64 alphabet.
      '!!!',
      '@@@@',
      '%%%@@@',
      'not base64 at all',
      'has spaces',
      'has\nnewline',
      'has=equals=in=middle',
      // Stray UTF-8 multi-byte sequence — atob expects ASCII binary string.
      'café',
    ];

    it.each(fixedNonBase64)('rejects non-base64 token %j', (token) => {
      expectCursorDecodeError(token);
    });

    it('property: random strings made of non-base64 characters are rejected', () => {
      // The base64 alphabet is [A-Za-z0-9+/=]. Picking units exclusively
      // outside that alphabet guarantees `atob` will throw on every sample.
      const nonBase64Char = fc.constantFrom(
        '!',
        '@',
        '#',
        '$',
        '%',
        '^',
        '&',
        '*',
        '(',
        ')',
        '<',
        '>',
        '?',
        ':',
        ';',
        '\\',
        '"',
        "'",
        ' ',
        '\n',
      );
      const nonBase64 = fc.string({ minLength: 1, maxLength: 32, unit: nonBase64Char });
      fc.assert(
        fc.property(nonBase64, (token) => {
          expectCursorDecodeError(token);
        }),
      );
    });
  });

  describe('non-JSON payload (valid base64, garbage UTF-8 inside)', () => {
    const fixed: readonly string[] = [
      // base64 of 'not json' / 'plain text' / arbitrary text.
      rawBase64('not json'),
      rawBase64('plain text'),
      rawBase64('1, 2, 3, oops'),
      rawBase64('{ ts: not quoted }'),
      rawBase64(''),
    ];

    it.each(fixed)('rejects base64 of non-JSON payload %#', (token) => {
      expectCursorDecodeError(token);
    });

    it('property: arbitrary text that is not valid JSON is rejected once base64-wrapped', () => {
      // Force the first character to one that JSON.parse always rejects, so
      // every sample is guaranteed non-JSON regardless of the rest.
      const nonJsonText = fc
        .tuple(fc.constantFrom('x', '@', '!', '%', '#', '?', ',', ':', '*'), fc.string())
        .map(([head, tail]) => head + tail);
      fc.assert(
        fc.property(nonJsonText, (text) => {
          expectCursorDecodeError(rawBase64(text));
        }),
      );
    });
  });

  describe('JSON shape violations', () => {
    const nonObjectPayloads: readonly string[] = [
      JSON.stringify(null),
      JSON.stringify(0),
      JSON.stringify(42),
      JSON.stringify('string'),
      JSON.stringify(true),
      JSON.stringify(false),
      JSON.stringify([]),
      JSON.stringify(['ts', 'id']),
    ];

    it.each(nonObjectPayloads)('rejects base64 of non-object JSON %j', (json) => {
      expectCursorDecodeError(rawBase64(json));
    });

    describe('missing field', () => {
      const missing: readonly (readonly [string, unknown])[] = [
        ['empty object', {}],
        ['only id', { id: 'abc' }],
        ['only ts', { ts: '2026-01-01T00:00:00.000Z' }],
        ['extra field but no ts/id', { foo: 'bar' }],
      ];

      it.each(missing)('rejects payload missing required field (%s)', (_label, payload) => {
        expectCursorDecodeError(rawBase64(JSON.stringify(payload)));
      });
    });

    describe('wrong type', () => {
      const wrongTypes: readonly (readonly [string, unknown])[] = [
        ['ts as number', { ts: 1735689600000, id: 'abc' }],
        ['ts as boolean', { ts: true, id: 'abc' }],
        ['ts as null', { ts: null, id: 'abc' }],
        ['ts as object', { ts: {}, id: 'abc' }],
        ['ts as empty string', { ts: '', id: 'abc' }],
        ['ts as non-date string', { ts: 'definitely not a date', id: 'abc' }],
        ['id as number', { ts: '2026-01-01T00:00:00.000Z', id: 7 }],
        ['id as null', { ts: '2026-01-01T00:00:00.000Z', id: null }],
        ['id as empty string', { ts: '2026-01-01T00:00:00.000Z', id: '' }],
        ['id as object', { ts: '2026-01-01T00:00:00.000Z', id: {} }],
        ['both wrong', { ts: 0, id: 0 }],
      ];

      it.each(wrongTypes)('rejects payload with %s', (_label, payload) => {
        expectCursorDecodeError(rawBase64(JSON.stringify(payload)));
      });
    });

    it('property: payloads with arbitrary non-string ts are rejected', () => {
      const nonStringTs = fc.oneof(
        fc.integer(),
        fc.double(),
        fc.boolean(),
        fc.constant(null),
        fc.array(fc.integer(), { maxLength: 3 }),
        fc.record({ nested: fc.string() }),
      );
      fc.assert(
        fc.property(nonStringTs, idArbitrary, (ts, id) => {
          const token = rawBase64(JSON.stringify({ ts, id }));
          expectCursorDecodeError(token);
        }),
      );
    });

    it('property: payloads with arbitrary non-string id are rejected', () => {
      const nonStringId = fc.oneof(
        fc.integer(),
        fc.double(),
        fc.boolean(),
        fc.constant(null),
        fc.array(fc.string(), { maxLength: 3 }),
      );
      fc.assert(
        fc.property(nonStringId, (id) => {
          const token = rawBase64(JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', id }));
          expectCursorDecodeError(token);
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// clampPageSize
// ---------------------------------------------------------------------------

describe('clampPageSize', () => {
  it('returns the default when input is undefined', () => {
    expect(clampPageSize(undefined)).toBe(50);
  });

  it('returns the custom default when input is undefined', () => {
    expect(clampPageSize(undefined, 25)).toBe(25);
  });

  it('falls back to the default for NaN', () => {
    expect(clampPageSize(Number.NaN)).toBe(50);
  });

  it('falls back to the default for +Infinity / -Infinity', () => {
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampPageSize(Number.NEGATIVE_INFINITY)).toBe(50);
  });

  it.each([
    [1, 1],
    [50, 50],
    [199, 199],
    [200, 200],
  ])('passes valid in-range value %i through (-> %i)', (input, expected) => {
    expect(clampPageSize(input)).toBe(expected);
  });

  it.each([
    [0, 1],
    [-1, 1],
    [-1_000_000, 1],
  ])('clamps non-positive input %i up to 1', (input, expected) => {
    expect(clampPageSize(input)).toBe(expected);
  });

  it.each([
    [201, 200],
    [1_000, 200],
    [1_000_000, 200],
  ])('clamps oversized input %i down to 200', (input, expected) => {
    expect(clampPageSize(input)).toBe(expected);
  });

  it('truncates fractional inputs to integers', () => {
    expect(clampPageSize(50.9)).toBe(50);
    expect(clampPageSize(199.999)).toBe(199);
    expect(clampPageSize(0.5)).toBe(1); // clamped up first, then truncated
  });

  it('honours custom def and max bounds', () => {
    expect(clampPageSize(undefined, 10, 20)).toBe(10);
    expect(clampPageSize(0, 10, 20)).toBe(1);
    expect(clampPageSize(50, 10, 20)).toBe(20);
    expect(clampPageSize(15, 10, 20)).toBe(15);
  });
});
