/**
 * Cursor encoder / decoder for the shared list pagination envelope.
 *
 * Every paginated `*:list` IPC channel uses an opaque cursor of the form
 * `base64(JSON({ ts: ISOString, id: string }))`. The cursor is produced by
 * the main process (from the last row of the previous page) and round-trips
 * unchanged through the renderer, which treats it as opaque.
 *
 * This module is intentionally pure JavaScript and free of Node-only
 * imports (no `Buffer`, no `node:*`) so the renderer can import it for
 * round-trip property tests and (eventually) for any client-side cursor
 * inspection. It targets the intersection of Node 18+ and modern browsers,
 * both of which expose global `btoa`, `atob`, `TextEncoder`, and
 * `TextDecoder`.
 *
 * Validates: Requirements 16.1, 16.2, 16.3.
 */

/**
 * Tagged error thrown by {@link decodeCursor} on any malformed input.
 *
 * The IPC router maps thrown `CursorDecodeError`s to
 * `Err('VALIDATION', { field: 'cursor' })` so renderer-side handlers see the
 * same shape regardless of whether the cursor was tampered with, truncated,
 * non-base64, non-JSON, missing fields, or contained the wrong types.
 *
 * Pattern-match either via `instanceof CursorDecodeError` or by the
 * stable `tag` property (useful when the error crosses a structured-clone
 * boundary that strips the prototype).
 */
export class CursorDecodeError extends Error {
  /** Stable discriminator; survives prototype loss across IPC boundaries. */
  public readonly tag = 'CURSOR_DECODE' as const;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CursorDecodeError';
    // Restore prototype chain when transpiled to ES5-style targets.
    Object.setPrototypeOf(this, CursorDecodeError.prototype);
  }
}

/** Cursor payload after decoding and validation. */
export interface CursorPayload {
  ts: Date;
  id: string;
}

/** Cursor input accepted by {@link encodeCursor}. */
export interface CursorInput {
  ts: Date | string;
  id: string;
}

/**
 * Encode a `(ts, id)` pair as an opaque base64 cursor token.
 *
 * `ts` is normalized to ISO 8601 via `Date.prototype.toISOString()` so the
 * encoded form is canonical and `decodeCursor(encodeCursor(x))` is
 * deterministic regardless of whether the caller passed a `Date` or a
 * string. `id` must be a non-empty string.
 *
 * Throws {@link TypeError} on invalid inputs — encoders are only ever called
 * by main-process code that owns the row it's encoding from, so a bad input
 * here is a programmer bug, not a request-validation failure.
 */
export function encodeCursor(input: CursorInput): string {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('encodeCursor: input must be an object');
  }

  const { ts, id } = input;

  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('encodeCursor: id must be a non-empty string');
  }

  let isoTs: string;
  if (ts instanceof Date) {
    if (Number.isNaN(ts.getTime())) {
      throw new TypeError('encodeCursor: ts is an invalid Date');
    }
    isoTs = ts.toISOString();
  } else if (typeof ts === 'string') {
    const parsed = new Date(ts);
    if (Number.isNaN(parsed.getTime())) {
      throw new TypeError('encodeCursor: ts is not a parseable ISO date string');
    }
    isoTs = parsed.toISOString();
  } else {
    throw new TypeError('encodeCursor: ts must be a Date or ISO date string');
  }

  const json = JSON.stringify({ ts: isoTs, id });
  return utf8ToBase64(json);
}

/**
 * Decode an opaque cursor token previously produced by {@link encodeCursor}.
 *
 * Throws {@link CursorDecodeError} on any malformed input — non-base64
 * payloads, non-JSON payloads, missing fields, wrong field types, an `id`
 * that is empty, or a `ts` that does not parse as a valid ISO date.
 */
export function decodeCursor(token: string): CursorPayload {
  if (typeof token !== 'string' || token.length === 0) {
    throw new CursorDecodeError('cursor must be a non-empty string');
  }

  let json: string;
  try {
    json = base64ToUtf8(token);
  } catch (cause) {
    throw new CursorDecodeError('cursor is not valid base64', { cause });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new CursorDecodeError('cursor payload is not valid JSON', { cause });
  }

  if (raw === null || typeof raw !== 'object') {
    throw new CursorDecodeError('cursor payload must be a JSON object');
  }

  const { ts, id } = raw as { ts?: unknown; id?: unknown };

  if (typeof ts !== 'string' || ts.length === 0) {
    throw new CursorDecodeError('cursor.ts must be a non-empty ISO date string');
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new CursorDecodeError('cursor.id must be a non-empty string');
  }

  const parsedTs = new Date(ts);
  if (Number.isNaN(parsedTs.getTime())) {
    throw new CursorDecodeError('cursor.ts does not parse as a valid date');
  }

  return { ts: parsedTs, id };
}

/**
 * Clamp a renderer-supplied `pageSize` to the agreed list-channel bounds.
 *
 * Returns `min(max(input ?? def, 1), max)`, additionally falling back to
 * `def` when the input is non-finite (`NaN`, `±Infinity`) and truncating
 * fractional values to integers so downstream SQL `LIMIT` always sees a
 * whole number. Both renderer- and main-side code call this helper so
 * there is exactly one definition of "the cap".
 *
 * Defaults match the design's list contract: `def = 50`, `max = 200`
 * (Requirements 16.1).
 */
export function clampPageSize(input: number | undefined, def = 50, max = 200): number {
  const candidate = input === undefined || !Number.isFinite(input) ? def : input;
  const clamped = Math.min(Math.max(candidate, 1), max);
  return Math.trunc(clamped);
}

// ---------------------------------------------------------------------------
// Internal: cross-environment UTF-8 ↔ base64 helpers.
//
// Both Node 18+ and modern browsers expose global `btoa`/`atob` plus
// `TextEncoder`/`TextDecoder`. Naive `btoa(json)` would corrupt any
// non-ASCII bytes (btoa expects a "binary string" of code points 0–255), so
// we encode to UTF-8 bytes first, marshal those bytes through a binary
// string, then base64. This keeps the module dependency-free while staying
// correct for any UTF-8 payload — the cursor schema is ASCII-only today,
// but baking that assumption in would be a footgun.
// ---------------------------------------------------------------------------

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  // Each byte is in [0, 255]; String.fromCharCode is the inverse of charCodeAt
  // and lets us hand a "binary string" to the global btoa.
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToUtf8(b: string): string {
  const binary = atob(b);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // `fatal: true` makes invalid UTF-8 sequences throw — surfaced as a
  // CursorDecodeError by the caller's try/catch.
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
