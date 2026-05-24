// src/main/ipc/router.ts
//
// IPC router with auth + RBAC + audit middleware (Phase 2, task 2.4).
//
// Every handler that runs in the main process is registered through
// `registerHandler(channel, opts, handler)`. The router wraps each call in a
// fixed middleware chain — the same chain that design.md > "Process and
// IPC contract" sketches and that the renderer relies on for the
// `Result<T>` envelope contract:
//
//   1. Auth.   Look the session up in `sessionStore` keyed by
//              `event.sender.id`. If `opts.requiresAuth` is `true` (the
//              default) and no session is bound, return
//              `Err('UNAUTHENTICATED')` and abort.
//
//   2. RBAC.   Consult the static matrix (`Permission.allows`). On denial,
//              best-effort write an `audit_logs` row of type `rbac.deny`
//              carrying the channel name + acting userId, and return
//              `Err('FORBIDDEN')` (Req 8.4, 13.4).
//
//   3. Handler. Invoke the registered function with a typed
//              `HandlerContext` carrying `senderId` and (when
//              authenticated) `session`. Any thrown exception is logged,
//              correlated by a generated `errorId`, and converted to
//              `Err('INTERNAL', undefined, { errorId })` so the renderer
//              sees a well-formed envelope rather than a rejected promise.
//
//   4. Audit.  If `opts.audit` is set AND the handler returned `Ok`,
//              best-effort write a single `audit_logs` row using the
//              descriptor's `actionType` / `entityType` and its
//              `extractPrevious` / `extractNext` extractors. This path is
//              the *declarative* audit lane: it is intentionally
//              POST-handler (and therefore post-commit), so an audit-write
//              failure cannot roll back an already-committed business
//              operation. Handlers that need *atomic* audit (e.g.
//              `price.change` in ProductService.upsert, task 4.3) write
//              the audit row inline within their own `$transaction`
//              instead of using this descriptor.
//
// The router is split into two halves so unit tests can drive the
// middleware chain without spinning up Electron's `ipcMain`:
//
//   - `registerHandler` and the inner `runHandler` are pure; they have no
//     runtime dependency on Electron (only a `type` import for `IpcMain`).
//     Tests use `invokeHandlerForTest(channel, senderId, req)` to feed a
//     fake event through the chain.
//
//   - `bindIpcHandlers(ipcMain)` is called once during main-process
//     bootstrap (`src/main/index.ts`) to attach every registered channel
//     to `ipcMain.handle`. This is the only place the running app touches
//     the Electron IPC surface.
//
// Validates: Requirements 1.5, 8.4, 13.4.

import { sessionStore } from '@main/auth/session-store.js';
import { prisma } from '@main/db/prisma.js';
import { Permission } from '@main/permission/matrix.js';
import { Err } from '@shared/result.js';

import type { Session } from '@main/auth/session-store.js';
import type { IpcChannel, IpcRequest, IpcResponse } from '@shared/ipc-contract.js';
import type { Result } from '@shared/result.js';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-call context handed to every handler. `senderId` is the renderer's
 * `WebContents.id`; auth-flow handlers (`auth:login`,
 * `setup:createInitialAdmin`) need it to bind a freshly-issued session via
 * `sessionStore.bind(senderId, session)`. `session` is present iff the
 * call passed the auth middleware (i.e. `opts.requiresAuth !== false` AND
 * a session was bound under `senderId`).
 */
export interface HandlerContext {
  readonly senderId: number;
  readonly session?: Session;
}

/**
 * Audit descriptor consumed by the (post-handler) audit middleware.
 *
 * `entityId` is required because `audit_logs.entity_id` is a non-null
 * column. For action types that operate on a single business entity
 * (e.g. `role.change` on a User), `entityId` typically reads from the
 * request or response. For coarse-grained events that don't have a
 * natural entity (e.g. middleware-driven RBAC denial), the channel name
 * is used as a stand-in — see the inline `rbac.deny` write below.
 *
 * `extractPrevious` runs against the request (the "before" state must be
 * captured before the handler mutates it) and `extractNext` runs against
 * both the request and the resolved response (so a service that returns
 * the freshly-updated DTO can drive the "after" snapshot directly).
 */
export interface AuditDescriptor<C extends IpcChannel> {
  readonly actionType: string;
  readonly entityType: string;
  readonly entityId: (req: IpcRequest<C>, res: IpcResponse<C>) => string;
  readonly extractPrevious?: (req: IpcRequest<C>) => unknown;
  readonly extractNext?: (req: IpcRequest<C>, res: IpcResponse<C>) => unknown;
}

/**
 * Per-handler middleware options.
 *
 * - `requiresAuth` defaults to `true`. The two auth-bootstrap channels
 *   (`auth:login` and `setup:createInitialAdmin`) explicitly set it to
 *   `false`; every other channel inherits the default.
 * - `audit`, when present, runs the declarative audit decorator described
 *   in the file header. Omit it for handlers that don't need an audit
 *   trail OR for handlers (like product price change) that emit their own
 *   audit row inside their service-level transaction.
 */
export interface HandlerOptions<C extends IpcChannel> {
  readonly requiresAuth?: boolean;
  readonly audit?: AuditDescriptor<C>;
}

/**
 * Handler signature. Returns a `Result<IpcResponse<C>>` so the renderer
 * always sees the wire-format envelope; throws are caught by the router
 * and converted to `Err('INTERNAL', { errorId })`.
 */
export type HandlerFn<C extends IpcChannel> = (
  req: IpcRequest<C>,
  ctx: HandlerContext,
) => Promise<Result<IpcResponse<C>>>;

// ---------------------------------------------------------------------------
// Audit writer (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Shape of a single audit row from the router's perspective. `previous`
 * and `next` are JSON-serializable values; the writer is responsible for
 * stringifying them into the `previous` / `next` columns of `audit_logs`.
 */
export interface AuditWriteInput {
  readonly actionType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly userId: string | null;
  readonly previous?: unknown;
  readonly next?: unknown;
}

/**
 * Pluggable audit-row writer. The router talks to this interface (not to
 * Prisma directly) so unit tests can record audit attempts without
 * touching SQLite.
 */
export interface AuditWriter {
  write(input: AuditWriteInput): Promise<void>;
}

/**
 * Default writer: persists audit rows via the `audit_logs` table. Stays
 * lazy — the inner `prisma.auditLog.create` is invoked only on the audit
 * code path, so importing the router does not by itself open the DB.
 */
export const prismaAuditWriter: AuditWriter = {
  async write(input) {
    await prisma.auditLog.create({
      data: {
        actionType: input.actionType,
        entityType: input.entityType,
        entityId: input.entityId,
        userId: input.userId,
        previous: input.previous !== undefined ? JSON.stringify(input.previous) : null,
        next: input.next !== undefined ? JSON.stringify(input.next) : null,
      },
    });
  },
};

let auditWriter: AuditWriter = prismaAuditWriter;

/**
 * Replace the active audit writer. Used by unit tests to capture audit
 * attempts in an in-memory recorder; production code should never call
 * this except during bootstrap if the writer becomes pluggable in a
 * future phase.
 */
export function setAuditWriter(writer: AuditWriter): void {
  auditWriter = writer;
}

/**
 * Reset the audit writer back to the production Prisma-backed
 * implementation. Convenience for tests' `afterEach` hooks.
 */
export function resetAuditWriter(): void {
  auditWriter = prismaAuditWriter;
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

/**
 * One row in the registry. Type-erased to `IpcChannel` so the registry
 * can be a homogeneous `Map`; the per-channel types are recovered at
 * dispatch time via the `<C extends IpcChannel>` generic on
 * `runHandler` / `invokeHandlerForTest`.
 */
interface RegisteredHandler {
  readonly opts: HandlerOptions<IpcChannel>;
  readonly fn: HandlerFn<IpcChannel>;
}

const handlers = new Map<IpcChannel, RegisteredHandler>();

/**
 * Register a handler for `channel`. Re-registering the same channel
 * replaces the previous entry (useful for hot reload during dev).
 */
export function registerHandler<C extends IpcChannel>(
  channel: C,
  opts: HandlerOptions<C>,
  handler: HandlerFn<C>,
): void {
  handlers.set(channel, {
    opts: opts as unknown as HandlerOptions<IpcChannel>,
    fn: handler as unknown as HandlerFn<IpcChannel>,
  });
}

/**
 * Drop every registered handler. Used by tests' `beforeEach` so cases
 * cannot leak handler registrations into one another.
 */
export function clearHandlers(): void {
  handlers.clear();
}

/**
 * Returns `true` iff a handler is registered for `channel`. Used by the
 * Electron binding loop and by exhaustiveness tests.
 */
export function hasHandler(channel: IpcChannel): boolean {
  return handlers.has(channel);
}

// ---------------------------------------------------------------------------
// Middleware chain
// ---------------------------------------------------------------------------

/**
 * Lightweight `errorId` generator used to correlate `INTERNAL` envelopes
 * with main-process logs. Sufficient for the current logging surface
 * (`console.error`) — Phase 11's structured logger will likely upgrade
 * this to a proper UUID.
 */
function generateErrorId(): string {
  const time = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 10);
  return `err_${time}_${noise}`;
}

/**
 * Run the full middleware chain for `channel` against `req`, looking up
 * the session under `senderId`. Pure: no Electron imports, no global
 * mutation outside the audit writer recording. Exported via
 * `invokeHandlerForTest` so unit tests can drive the chain directly.
 */
async function runHandler<C extends IpcChannel>(
  channel: C,
  senderId: number,
  req: IpcRequest<C>,
): Promise<Result<IpcResponse<C>>> {
  const entry = handlers.get(channel);
  if (!entry) {
    // The Electron binding loop only registers channels that exist in the
    // map, so this branch is reachable only via a misuse of
    // `invokeHandlerForTest`. Returning INTERNAL keeps the envelope
    // contract intact and surfaces the bug loudly in test output.
    const errorId = generateErrorId();
    console.error(`[ipc.router] no handler registered for ${channel} (errorId=${errorId})`);
    return Err('INTERNAL', { channel }, { errorId });
  }

  const opts = entry.opts as HandlerOptions<C>;
  const requiresAuth = opts.requiresAuth ?? true;

  // 1. Auth ----------------------------------------------------------------
  const session = sessionStore.get(senderId);
  if (requiresAuth && session === undefined) {
    return Err('UNAUTHENTICATED');
  }

  // 2. RBAC ----------------------------------------------------------------
  // Only consult the matrix when the channel requires auth AND a session
  // exists. Public channels (login, initial setup) bypass RBAC entirely;
  // their access control is enforced at the service layer (e.g.
  // `hasAnyAdmin()` for setup).
  if (requiresAuth && session !== undefined) {
    if (!Permission.allows(session.role, channel)) {
      // Best-effort write; audit failure must not turn a deny into a
      // success or change the visible envelope.
      try {
        await auditWriter.write({
          actionType: 'rbac.deny',
          entityType: 'ipc',
          entityId: channel,
          userId: session.userId,
          next: { channel, role: session.role },
        });
      } catch (err) {
        console.error(`[ipc.router] failed to write rbac.deny audit row for ${channel}`, err);
      }
      return Err('FORBIDDEN', { channel });
    }
  }

  // 3. Handler -------------------------------------------------------------
  // `exactOptionalPropertyTypes` requires us to construct the context
  // without a literal `session: undefined` when no session is present.
  const ctx: HandlerContext = session !== undefined ? { senderId, session } : { senderId };

  let result: Result<IpcResponse<C>>;
  try {
    result = await (entry.fn as unknown as HandlerFn<C>)(req, ctx);
  } catch (err) {
    const errorId = generateErrorId();
    console.error(`[ipc.router] handler for ${channel} threw (errorId=${errorId})`, err);
    return Err('INTERNAL', undefined, { errorId });
  }

  // 4. Audit (declarative, post-handler, best-effort) ----------------------
  // Only fires on Ok. Audit failures are logged but never override a
  // committed business result — flipping a successful sale into a failure
  // because the audit insert hit a transient SQLITE_BUSY would be a far
  // worse outcome than a missing audit row.
  if (result.ok && opts.audit !== undefined) {
    const descriptor = opts.audit;
    try {
      const entityId = descriptor.entityId(req, result.value);
      const previous =
        descriptor.extractPrevious !== undefined ? descriptor.extractPrevious(req) : undefined;
      const next =
        descriptor.extractNext !== undefined
          ? descriptor.extractNext(req, result.value)
          : undefined;
      await auditWriter.write({
        actionType: descriptor.actionType,
        entityType: descriptor.entityType,
        entityId,
        userId: session?.userId ?? null,
        ...(previous !== undefined ? { previous } : {}),
        ...(next !== undefined ? { next } : {}),
      });
    } catch (err) {
      console.error(`[ipc.router] audit write failed for ${channel}`, err);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Drive the middleware chain directly with a fake `senderId`. Lives next
 * to the chain itself so tests cannot drift away from production
 * semantics — the router has exactly one execution path.
 */
export async function invokeHandlerForTest<C extends IpcChannel>(
  channel: C,
  senderId: number,
  req: IpcRequest<C>,
): Promise<Result<IpcResponse<C>>> {
  return runHandler(channel, senderId, req);
}

// ---------------------------------------------------------------------------
// Electron binding
// ---------------------------------------------------------------------------

/**
 * Attach every registered handler to `ipcMain.handle`. Called once during
 * main-process bootstrap, after all handler-group modules have run their
 * `registerHandler` calls.
 *
 * The binding wraps `runHandler` in an outer try/catch as a defense in
 * depth: if a future change introduces a code path that throws *outside*
 * the inner middleware chain, the renderer still sees a well-formed
 * `Err('INTERNAL')` envelope rather than a rejected promise.
 */
export function bindIpcHandlers(ipcMain: IpcMain): void {
  for (const channel of handlers.keys()) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      try {
        return await runHandler(channel, event.sender.id, payload as never);
      } catch (err) {
        const errorId = generateErrorId();
        console.error(
          `[ipc.router] uncaught error in dispatch for ${channel} (errorId=${errorId})`,
          err,
        );
        return Err('INTERNAL', undefined, { errorId });
      }
    });
  }
}
