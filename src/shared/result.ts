/**
 * Result envelope shared across the main / preload / renderer processes.
 *
 * Every IPC handler returns `Result<T, ErrorEnvelope>`; the renderer never
 * throws on IPC, it pattern-matches `result.ok`. This file is the single
 * source of truth for that contract (design.md > "Error handling" >
 * "Result envelope") and is the foundation for handlers (task 2.4),
 * RBAC denial (task 2.6), and the toast / inline error system (task 13.4).
 *
 * Design references:
 *   - Requirements 1.2, 3.7, 4.8, 4.9, 5.5, 8.4, 15.1
 *   - design.md error taxonomy table for the full code list and surface map
 *
 * Conventions:
 *   - `code` is a string-literal discriminant — no string codes outside this union.
 *   - `details` is an open `Record<string, unknown>` so callers can attach
 *     context (offending productId, validation field path, audit flags) without
 *     a follow-up type change. Renderer code must treat it as untrusted shape.
 *   - `errorId` is reserved for `INTERNAL` errors that we also write to the log
 *     file; the renderer surfaces it so users can quote it in support tickets.
 *   - The module is process-agnostic: zero imports, zero side effects, zero
 *     Node / DOM globals so it links cleanly into all three tsconfigs.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminated union covering every error category surfaced across the IPC
 * boundary. The exact list is mirrored from design.md so the error taxonomy
 * table and the type stay in lock-step. New codes must be added in both places.
 */
export type ErrorCode =
  | 'VALIDATION'
  | 'OUT_OF_STOCK'
  | 'UNIQUE_VIOLATION'
  | 'FK_VIOLATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'USER_CANCELED'
  | 'PRINTER_FAILURE'
  | 'DB_INTEGRITY'
  | 'INTERNAL';

/**
 * Wire-format error returned by every IPC handler. `message` is the
 * default-or-overridden human string; `details` is a structured payload for
 * UI surfaces (e.g. inline form errors, per-line cart markers); `errorId`
 * correlates an `INTERNAL` toast with a log file entry.
 *
 * Note on `exactOptionalPropertyTypes`: optional fields are either present
 * with a defined value or absent — never explicitly `undefined`. The `Err`
 * factory below honours this by building the envelope conditionally.
 */
export interface ErrorEnvelope {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly errorId?: string;
}

/** Successful branch of a `Result`. */
export interface OkResult<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed branch of a `Result`. */
export interface ErrResult<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * Standard result envelope. Defaults `E` to `ErrorEnvelope` so the typical
 * IPC handler signature (`Promise<Result<Foo>>`) stays terse, but callers
 * with richer error types (e.g. zod parse results) can override it.
 */
export type Result<T, E = ErrorEnvelope> = OkResult<T> | ErrResult<E>;

// ---------------------------------------------------------------------------
// Default messages
// ---------------------------------------------------------------------------

/**
 * Human-readable defaults per error code. Renderer toasts and inline form
 * errors override these via the central error mapper (task 13.4); these
 * exist so handlers can call `Err('FORBIDDEN')` without repeating boilerplate
 * and so log lines for never-shown errors still read sensibly.
 */
const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  VALIDATION: 'The request did not pass validation.',
  OUT_OF_STOCK: 'One or more items are out of stock.',
  UNIQUE_VIOLATION: 'A record with this value already exists.',
  FK_VIOLATION: 'A referenced record could not be found.',
  UNAUTHENTICATED: 'You must be signed in to perform this action.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  USER_CANCELED: 'The operation was canceled.',
  PRINTER_FAILURE: 'The receipt printer is unavailable.',
  DB_INTEGRITY: 'The database failed an integrity check.',
  INTERNAL: 'An unexpected error occurred.',
};

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Wrap a successful value in a `Result`. */
export function Ok<T>(value: T): OkResult<T> {
  return { ok: true, value };
}

/**
 * Optional fields when constructing an `ErrorEnvelope`. Kept separate from
 * `details` so callers can override the default message or attach an
 * `errorId` without colliding with arbitrary user-supplied detail keys.
 */
export interface ErrOptions {
  /** Override the default message for this code. */
  readonly message?: string;
  /**
   * Correlation id, typically populated for `INTERNAL` so renderer toasts
   * and log files can be cross-referenced.
   */
  readonly errorId?: string;
}

/**
 * Build a failing `Result` carrying an `ErrorEnvelope`.
 *
 * Usage matches the design.md examples:
 *   Err('FORBIDDEN', { auditDenial: true })
 *   Err('OUT_OF_STOCK', { productId })
 *   Err('UNIQUE_VIOLATION', extractFields(e))
 *   Err('INTERNAL', undefined, { errorId })
 *   Err('UNAUTHENTICATED')
 *
 * The envelope is built field-by-field so optional properties are absent
 * (never `undefined`) under `exactOptionalPropertyTypes`.
 */
export function Err(
  code: ErrorCode,
  details?: Readonly<Record<string, unknown>>,
  options?: ErrOptions,
): ErrResult<ErrorEnvelope> {
  const message = options?.message ?? DEFAULT_MESSAGES[code];

  // Spread-builder keeps optional keys absent unless a defined value was
  // supplied — required for exactOptionalPropertyTypes compliance.
  const envelope: ErrorEnvelope = {
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    ...(options?.errorId !== undefined ? { errorId: options.errorId } : {}),
  };

  return { ok: false, error: envelope };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Narrow a `Result` to its success branch. */
export function isOk<T, E>(result: Result<T, E>): result is OkResult<T> {
  return result.ok === true;
}

/** Narrow a `Result` to its failure branch. */
export function isErr<T, E>(result: Result<T, E>): result is ErrResult<E> {
  return result.ok === false;
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/**
 * Thrown by `unwrap` when called on a failing `Result`. Carries the original
 * error so a top-level catch (e.g. an IPC adapter that bridges to a thrown
 * exception in tests) can preserve the envelope without stringifying it.
 */
export class UnwrapError<E> extends Error {
  public readonly error: E;

  public constructor(error: E) {
    const detail =
      error !== null && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown';
    super(`Called unwrap() on an Err result (code=${detail})`);
    this.name = 'UnwrapError';
    this.error = error;
  }
}

/**
 * Extract the success value or throw. Use only in code paths that have
 * already established (via `isOk` or `match`) that the result is a success,
 * or in tests where an unexpected `Err` should fail loudly.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw new UnwrapError<E>(result.error);
}

/**
 * Pattern-matching combinator. Both branches must return the same type so
 * the caller can use `match` directly inside an expression (e.g. a JSX
 * ternary or a return value). The renderer's central error mapper (task
 * 13.4) is the canonical consumer.
 */
export function match<T, E, U>(
  result: Result<T, E>,
  handlers: {
    readonly ok: (value: T) => U;
    readonly err: (error: E) => U;
  },
): U {
  if (result.ok) {
    return handlers.ok(result.value);
  }
  return handlers.err(result.error);
}
