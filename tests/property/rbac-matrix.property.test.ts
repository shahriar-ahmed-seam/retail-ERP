// tests/property/rbac-matrix.property.test.ts
//
// Phase 12, task 12.3 — Property 9: RBAC matrix is enforced on every
// IPC channel.
//
// **Validates: Requirements 1.5, 8.2, 8.3, 8.4.**
//
// For every channel `c` in `IPC_CHANNELS` and every role `r` in
// `['Admin', 'Cashier']`, the property drives a single
// `invokeHandlerForTest(c, sender, dummyPayload)` call through the
// REAL router with a session bound to `r` and asserts:
//
//   - The success path is taken iff `RBAC[c].includes(r)`. The stub
//     handler registered for the channel returns `Ok` and the
//     envelope on the wire is `Ok` too.
//   - Otherwise the call returns `Err('FORBIDDEN')` AND a single
//     `audit_logs` row of `actionType: 'rbac.deny'`, `entityType:
//     'ipc'`, `entityId === channel`, and `userId` set to the acting
//     user is written through the recording audit writer.
//
// The recording audit writer pattern is the same one
// `tests/unit/main/ipc/handlers/reports.test.ts` already uses — a
// `setAuditWriter()` swap-in plus a `RecordingAuditWriter`
// implementation that captures `AuditWriteInput`s in an array. Tests
// reset the recorder at the start of every (channel, role) check so
// the assertion can read a single row deterministically.
//
// Channels exempt from this property:
//
//   - `auth:login` / `auth:logout` — registered with
//     `requiresAuth: false`; the router never reaches the RBAC stage
//     for them. Their matrix entry is `ALL_ROLES` so a deny would
//     never fire, and adding them to the property would only test the
//     auth-bypass path that is already covered by
//     `tests/unit/main/ipc/handlers/auth.test.ts`.
//   - `setup:createInitialAdmin` / `setup:isRequired` — also
//     `requiresAuth: false` and gated at the service layer
//     (`hasAnyAdmin()`). Their matrix entry is `NO_ROLE` which
//     enforces the static "no authenticated session ever authorizes
//     setup" invariant — this is a defence-in-depth check rather
//     than a runtime gate, so driving it through the router with a
//     bound session would test the wrong thing.
//
// fast-check is used to (a) generate the acting role per iteration
// and (b) shuffle the channel order so the assertion does not
// silently depend on declaration order. `numRuns: 1` is sufficient
// because the property body iterates the full (channel × role) grid
// on every iteration — fast-check is a shuffler here, not a search.
//
// The test mocks NO services and registers no real handler-group
// modules. Instead, every channel under test gets a tiny stub
// handler that returns `Ok({} as never)`. This keeps the property
// strictly about router behaviour: auth gate → RBAC gate → handler.
// The stub never runs for forbidden roles (the RBAC gate intercepts
// first), and runs successfully for permitted roles (returning the
// stub's `Ok` envelope).

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionStore } from '@main/auth/session-store';
import {
  clearHandlers,
  invokeHandlerForTest,
  registerHandler,
  resetAuditWriter,
  setAuditWriter,
  type AuditWriteInput,
  type AuditWriter,
} from '@main/ipc/router';
import { RBAC } from '@main/permission/matrix';
import {
  IPC_CHANNELS,
  type IpcChannel,
  type SessionRole,
} from '@shared/ipc-contract';
import { Ok } from '@shared/result';

// ---------------------------------------------------------------------------
// Recording audit writer (mirrors the pattern in
// `tests/unit/main/ipc/handlers/reports.test.ts`)
// ---------------------------------------------------------------------------

class RecordingAuditWriter implements AuditWriter {
  public readonly rows: AuditWriteInput[] = [];
  public write(input: AuditWriteInput): Promise<void> {
    this.rows.push(input);
    return Promise.resolve();
  }
  public reset(): void {
    this.rows.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Fixture configuration
// ---------------------------------------------------------------------------

/**
 * Channels exempt from the property — see the file header for the
 * rationale. These all carry `requiresAuth: false` in their handler
 * registrations and therefore never reach the RBAC middleware in
 * production.
 */
const PUBLIC_CHANNELS: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'auth:login',
  'auth:logout',
  'setup:createInitialAdmin',
  'setup:isRequired',
]);

/** Roles to exercise per channel. The `SessionRole` union is exactly
 *  these two values (`src/shared/ipc-contract.ts`); listing them
 *  explicitly keeps the assertion readable. */
const ROLES: readonly SessionRole[] = Object.freeze(['Admin', 'Cashier']);

/** Channels actually under test — every `IpcContract` channel except
 *  the four public-bypass ones. */
const TESTABLE_CHANNELS: readonly IpcChannel[] = IPC_CHANNELS.filter(
  (c) => !PUBLIC_CHANNELS.has(c),
);

/** Synthetic renderer sender id. The router only uses it as a key
 *  into `sessionStore`; any number works. */
const SENDER_ID = 7;

let recorder: RecordingAuditWriter;

beforeEach(() => {
  // Silence the router's `[ipc.router] failed to write rbac.deny ...`
  // log line — the recording writer never throws, but the router has
  // a defensive `console.error` for a real Prisma writer that does.
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence */
  });

  clearHandlers();
  sessionStore.clearAll();

  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  // Register a tiny pass-through stub for every channel under test.
  // Default `requiresAuth: true` so the auth + RBAC middleware fires
  // before the stub. The stub returns `Ok({})` regardless of the
  // declared `IpcResponse<C>` shape; the router does not inspect the
  // value on the wire, only `result.ok`. Forbidden calls never reach
  // the stub.
  for (const channel of TESTABLE_CHANNELS) {
    registerHandler(channel, {}, () => Promise.resolve(Ok({} as never)));
  }
});

afterEach(() => {
  resetAuditWriter();
  clearHandlers();
  sessionStore.clearAll();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Property 9 — RBAC matrix is enforced on every IPC channel
// ---------------------------------------------------------------------------

describe('Property 9 — RBAC matrix enforcement on every IPC channel', () => {
  it(
    'every (channel, role) pair: success iff RBAC permits, otherwise FORBIDDEN with a single rbac.deny audit row',
    async () => {
      // numRuns: 1 — the assertion runs the full (channel × role)
      // matrix on every iteration regardless of what fast-check
      // generates, so a single iteration exhausts the property
      // domain. The arbitrary's only role here is to randomize
      // channel iteration order so a regression that silently
      // depends on declaration order surfaces under FAST_CHECK_SEED
      // replay rather than hiding behind a stable iteration order.
      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray([...TESTABLE_CHANNELS], {
            minLength: TESTABLE_CHANNELS.length,
            maxLength: TESTABLE_CHANNELS.length,
          }),
          async (shuffledChannels: readonly IpcChannel[]) => {
            // Run BOTH roles inside every iteration — the property is
            // about the matrix-coverage grid, not a single role.
            for (const role of ROLES) {
              for (const channel of shuffledChannels) {
                // Reset the recorder + session per (channel, role)
                // check so the assertion below can identify the
                // single audit row produced by THIS call without
                // worrying about prior history.
                recorder.reset();
                sessionStore.clearAll();
                sessionStore.bind(SENDER_ID, {
                  userId: `u-${role}`,
                  role,
                  sessionId: `s-${role}`,
                  createdAt: new Date(),
                });

                const result = await invokeHandlerForTest(
                  channel,
                  SENDER_ID,
                  // The router does not type-check the payload; it
                  // forwards whatever it receives to the handler. The
                  // stub ignores it.
                  undefined as never,
                );

                const allowed = RBAC[channel].includes(role);

                if (allowed) {
                  // Success path: the stub handler ran and returned
                  // `Ok`. No `rbac.deny` row was written.
                  expect(
                    result.ok,
                    `[Property 9] channel '${channel}' role '${role}': expected Ok but got ${
                      result.ok ? '?' : result.error.code
                    }`,
                  ).toBe(true);

                  const denyRow = recorder.rows.find(
                    (r) => r.actionType === 'rbac.deny',
                  );
                  expect(
                    denyRow,
                    `[Property 9] channel '${channel}' role '${role}': permitted call wrote an rbac.deny audit row`,
                  ).toBeUndefined();
                } else {
                  // Denial path: router returned FORBIDDEN and wrote
                  // exactly one `rbac.deny` audit row carrying the
                  // channel name as `entityId` (Req 8.4).
                  expect(
                    result.ok,
                    `[Property 9] channel '${channel}' role '${role}': forbidden call returned Ok`,
                  ).toBe(false);
                  if (result.ok) return; // narrow for TS
                  expect(result.error.code).toBe('FORBIDDEN');

                  const denyRows = recorder.rows.filter(
                    (r) => r.actionType === 'rbac.deny',
                  );
                  expect(
                    denyRows.length,
                    `[Property 9] channel '${channel}' role '${role}': expected exactly one rbac.deny row, got ${denyRows.length}`,
                  ).toBe(1);

                  const denyRow = denyRows[0];
                  expect(denyRow).toBeDefined();
                  if (denyRow === undefined) return; // narrow for TS
                  expect(denyRow.entityType).toBe('ipc');
                  expect(denyRow.entityId).toBe(channel);
                  expect(denyRow.userId).toBe(`u-${role}`);
                }
              }
            }
          },
        ),
        { numRuns: 1 },
      );
    },
    // The assertion does ~|channels| × 2 router invocations per
    // iteration (~70 total). Each invocation is a synchronous
    // function call against an in-memory recorder — well under a
    // millisecond — so the default 30s property timeout is plenty.
    30_000,
  );
});
