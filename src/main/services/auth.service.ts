// src/main/services/auth.service.ts
//
// Auth domain service — login, logout, first-run setup, and the
// `hasAnyAdmin()` predicate the bootstrap uses to gate the setup screen
// (Phase 3, task 3.1).
//
// Responsibilities (per design.md > "Module breakdown" and tasks.md task 3.1):
//   - Hash and verify passwords with `bcrypt` at cost factor 12 (Req 1.3).
//     Cost 12 is the design's chosen working factor: ~250ms on a modern CPU,
//     well below the 500ms POS finalize target so login latency stays in
//     the human-perception band, and high enough to make offline brute
//     force attacks against an exfiltrated `shop.db` impractical.
//   - Allocate a freshly-generated session id (`crypto.randomUUID`) on
//     every successful login / setup. The service does NOT bind that
//     session to a renderer — that is the IPC handler's job (task 3.2),
//     because only the handler has access to `event.sender.id` from the
//     IPC context. Centralizing the bind in the service would force
//     handlers to leak the senderId into the service signature for every
//     other channel too.
//   - Return `Result<T, ErrorEnvelope>` for every public method so the
//     IPC router middleware can surface errors uniformly. Login
//     failures collapse to a single `UNAUTHENTICATED` code regardless of
//     whether the username was unknown or the password mismatched —
//     this is the standard defence against username enumeration and
//     mirrors the error envelope notes in design.md > "Error handling".
//   - NEVER return `passwordHash` on any code path. Both `login` and
//     `createInitialAdmin` build their response shapes by hand from the
//     fields the renderer needs (`UserDTO`, `SessionDTO`) so a future
//     `select` change to `prisma.user.findUnique` cannot accidentally
//     leak the hash through the IPC boundary.
//
// What the service does NOT do (intentionally):
//   - Bind sessions to renderer senderIds. The handler binds via
//     `sessionStore.bind(event.sender.id, session)` after a successful
//     `Ok(...)` returns from this service.
//   - Map sessionId → senderId for `logout`. The session store is keyed
//     by senderId (Phase 2, task 2.5) and Electron is a single-window
//     app, so the IPC handler can clear the binding directly via
//     `event.sender.id` without re-deriving it from the sessionId. The
//     `logout` method below therefore takes the senderId straight from
//     the handler's ctx; the task description's `logout(sessionId)`
//     wording is reconciled in the comment above each method.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6.

import { randomUUID } from 'node:crypto';

import bcrypt from 'bcrypt';

import { sessionStore, type SenderId } from '@main/auth/session-store.js';
import { prisma } from '@main/db/prisma.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type { SessionDTO, SessionRole, UserDTO } from '@shared/ipc-contract.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * bcrypt working factor (Req 1.3). Exported so tests can assert the hash
 * prefix (`$2b$12$`) against this constant rather than a magic number.
 */
export const BCRYPT_COST_FACTOR = 12;

/** The seeded role name used to gate the initial-admin flow (prisma/seed.ts). */
const ADMIN_ROLE_NAME = 'Admin';

/**
 * Username bounds. The lower bound rejects empty / whitespace-only input;
 * the upper bound matches a comfortable display width on the login page
 * and prevents pathological inputs from hitting the bcrypt path. The
 * actual database column is `String` (no length limit on SQLite); these
 * bounds are an application-level guardrail.
 */
const USERNAME_MIN_LENGTH = 1;
const USERNAME_MAX_LENGTH = 50;

/**
 * Password lower bound. 8 characters is the design's chosen minimum and
 * matches common B2B baseline policy. The upper bound is bcrypt's own
 * 72-byte limit, which we allow Prisma + bcrypt to enforce naturally
 * rather than re-encoding here.
 */
const PASSWORD_MIN_LENGTH = 8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result envelope returned by {@link AuthService.createInitialAdmin}.
 *
 * Returns both the `UserDTO` (so the handler / renderer can populate the
 * users management view) and the freshly-allocated `SessionDTO` (so the
 * handler can immediately bind the new admin's session and route into
 * the app without a separate login round-trip on first launch).
 *
 * The IPC contract for `setup:createInitialAdmin` (task 3.2) returns
 * only `SessionDTO`; the richer service-level shape is preserved here
 * for callers (tests, future internal flows) that need both halves.
 */
export interface CreateInitialAdminResult {
  readonly user: UserDTO;
  readonly sessionDTO: SessionDTO;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate the application-level bounds on a username. Returns the
 * trimmed value when valid (so callers persist the canonical form), or
 * `null` to signal a `VALIDATION` failure.
 *
 * `null` rather than throwing keeps the caller's control flow shallow:
 * `if (!validated) return Err('VALIDATION', { field: 'username' })`.
 */
function validateUsername(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length < USERNAME_MIN_LENGTH || trimmed.length > USERNAME_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

/**
 * Validate that the password meets the application-level minimum. We
 * deliberately do not trim — leading/trailing whitespace might be part
 * of the user's chosen secret. Returns the original string on success
 * or `null` on failure.
 */
function validatePassword(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (input.length < PASSWORD_MIN_LENGTH) return null;
  return input;
}

/**
 * Narrow a free-form role name (from the `Role` table) to the
 * `SessionRole` literal union. Anything outside `'Admin' | 'Cashier'`
 * is a database-integrity issue — the seed only writes those two —
 * and surfaces as `DB_INTEGRITY` so an installer / migration bug does
 * not silently round-trip into the renderer.
 */
function narrowSessionRole(roleName: string): SessionRole | null {
  if (roleName === 'Admin' || roleName === 'Cashier') return roleName;
  return null;
}

/**
 * Build a `UserDTO` from a Prisma user record without ever reading the
 * `passwordHash` column. The shape matches `UserDTO` in
 * `src/shared/ipc-contract.ts` so the handler can return it verbatim
 * without further mapping.
 */
function toUserDTO(
  user: { readonly id: string; readonly username: string; readonly roleId: string; readonly createdAt: Date },
  roleName: SessionRole,
): UserDTO {
  return {
    id: user.id,
    username: user.username,
    roleId: user.roleId,
    roleName,
    createdAt: user.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------

/**
 * Auth service surface. Exposed as a frozen object literal (matching
 * the `Permission` namespace style in `src/main/permission/matrix.ts`)
 * so callers import a single named symbol and the IPC handlers in
 * task 3.2 can wire each method to its channel without instantiating
 * a class.
 *
 * All methods are `async` and return `Result<T, ErrorEnvelope>`; none
 * throw on the documented error paths. Unhandled exceptions (e.g. a
 * Prisma connection failure) bubble up so the IPC router middleware
 * can wrap them in `Err('INTERNAL', ..., { errorId })`.
 */
export const AuthService = {
  /**
   * Returns `true` iff at least one user with the `Admin` role exists.
   *
   * Used by:
   *   - the bootstrap to decide whether to render the setup screen
   *     (Req 1.6, Phase 3 task 3.4),
   *   - `createInitialAdmin` itself as a defence-in-depth check before
   *     creating the second admin would otherwise be possible.
   *
   * Implementation notes:
   *   - Two queries (role lookup + user count) is fine here. This runs
   *     at most once per process launch via the bootstrap and at most
   *     once per first-run setup attempt; not a hot path.
   *   - When the `Admin` role row is missing entirely, we treat that
   *     as "no admins" rather than an error, because the setup flow
   *     is what ultimately repairs / depends on the seeded role row
   *     being present, and surfacing an error here would deadlock
   *     first-run on a partially-seeded database.
   */
  async hasAnyAdmin(): Promise<boolean> {
    const adminRole = await prisma.role.findUnique({ where: { name: ADMIN_ROLE_NAME } });
    if (adminRole === null) return false;
    const count = await prisma.user.count({ where: { roleId: adminRole.id } });
    return count > 0;
  },

  /**
   * Create the initial Admin user (Req 1.6).
   *
   * Behaviour:
   *   1. Validate `username` (1..50 chars after trim) and `password`
   *      (>= 8 chars). Either failure returns
   *      `Err('VALIDATION', { field })` so the renderer can mark the
   *      offending input.
   *   2. Reject with `Err('FORBIDDEN', { reason: 'admin_already_exists' })`
   *      if any admin already exists. This is the gate that makes the
   *      setup channel safe to leave wired up after first launch.
   *   3. Look up the seeded `Admin` role. A missing role indicates the
   *      database was not seeded correctly — surface as `DB_INTEGRITY`.
   *   4. Hash the password with `bcrypt.hash(password, 12)` and create
   *      the user. The unique constraint on `User.username` would catch
   *      a duplicate but the validation step is the primary guard.
   *   5. Allocate a fresh `sessionId` via `crypto.randomUUID()` and
   *      return both the new user (as a `UserDTO`) and the
   *      `SessionDTO`. The handler (task 3.2) is responsible for
   *      calling `sessionStore.bind(event.sender.id, ...)` so the
   *      newly-created admin is logged in immediately after setup.
   *
   * The check + create pair is not transactional. In a single-window
   * Electron app the race is not reachable (only the bootstrap window
   * can call this channel), and the unique constraint on `username`
   * provides a backstop. A future multi-window flow that wanted hard
   * serialization would wrap the body in `prisma.$transaction(async (tx) => …)`.
   */
  async createInitialAdmin(
    username: string,
    password: string,
  ): Promise<Result<CreateInitialAdminResult>> {
    const trimmedUsername = validateUsername(username);
    if (trimmedUsername === null) {
      return Err('VALIDATION', { field: 'username' });
    }
    const validatedPassword = validatePassword(password);
    if (validatedPassword === null) {
      return Err('VALIDATION', { field: 'password' });
    }

    if (await AuthService.hasAnyAdmin()) {
      return Err('FORBIDDEN', { reason: 'admin_already_exists' });
    }

    const adminRole = await prisma.role.findUnique({ where: { name: ADMIN_ROLE_NAME } });
    if (adminRole === null) {
      // The seed (prisma/seed.ts) is responsible for writing this row.
      // Reaching this branch means the bundled `shop.db.template` build
      // (Phase 1, task 1.5) or the per-launch migration step is broken.
      return Err('DB_INTEGRITY', { missing: 'role:Admin' });
    }

    const passwordHash = await bcrypt.hash(validatedPassword, BCRYPT_COST_FACTOR);

    const created = await prisma.user.create({
      data: {
        username: trimmedUsername,
        passwordHash,
        roleId: adminRole.id,
      },
    });

    const sessionId = randomUUID();
    const sessionDTO: SessionDTO = {
      sessionId,
      userId: created.id,
      username: created.username,
      role: 'Admin',
    };

    return Ok({
      user: toUserDTO(created, 'Admin'),
      sessionDTO,
    });
  },

  /**
   * Authenticate a user and allocate a session.
   *
   * Returns `Err('UNAUTHENTICATED')` for both unknown-username and
   * wrong-password paths so a caller cannot tell the two apart from
   * the response (defence against username enumeration). The same
   * envelope is returned for non-string inputs as a final guardrail
   * against a renderer that bypassed its own form validation.
   *
   * On success:
   *   - The renderer receives a `SessionDTO` containing `sessionId`
   *     (opaque handle for `auth:logout` to pass back), `userId`,
   *     `username`, and `role`.
   *   - The handler (task 3.2) binds the session into
   *     `sessionStore` keyed by the renderer's `event.sender.id`.
   *     Subsequent IPC calls from that renderer pass the auth +
   *     RBAC middleware via that binding.
   *
   * `passwordHash` is read off the user record only as input to
   * `bcrypt.compare` and is not included in the returned shape.
   */
  async login(username: string, password: string): Promise<Result<SessionDTO>> {
    if (typeof username !== 'string' || typeof password !== 'string') {
      return Err('UNAUTHENTICATED');
    }

    // Trim usernames on lookup so leading/trailing whitespace does not
    // create a "stuck out" account; passwords are NOT trimmed.
    const lookupName = username.trim();
    if (lookupName.length === 0) {
      return Err('UNAUTHENTICATED');
    }

    const user = await prisma.user.findUnique({
      where: { username: lookupName },
      include: { role: true },
    });

    if (user === null) {
      return Err('UNAUTHENTICATED');
    }

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      return Err('UNAUTHENTICATED');
    }

    const role = narrowSessionRole(user.role.name);
    if (role === null) {
      // A role row outside the `Admin | Cashier` set indicates DB
      // tampering or a forward-incompatible migration. We refuse to
      // mint a session rather than guess.
      return Err('DB_INTEGRITY', { reason: 'unknown_role', name: user.role.name });
    }

    const sessionId = randomUUID();
    return Ok({
      sessionId,
      userId: user.id,
      username: user.username,
      role,
    });
  },

  /**
   * Tear down the session bound to a renderer.
   *
   * Parameter naming reconciliation: the task description in tasks.md
   * lists this method as `logout(sessionId)`. In practice the session
   * store is keyed by `senderId` (Phase 2, task 2.5) — Electron's
   * `WebContents.id` for the renderer that called the IPC channel —
   * because that is the only id available to the auth middleware on
   * every other invoke. Mapping a sessionId back to a senderId would
   * require iterating the store on every logout, and the result is
   * always the renderer that issued the call. Taking the senderId
   * directly from the handler's `event.sender.id` is both simpler
   * and the only call shape consistent with the rest of the
   * middleware stack.
   *
   * The IPC handler (task 3.2) is therefore expected to call
   * `AuthService.logout(event.sender.id)` regardless of whatever
   * sessionId the renderer included in its request payload (the
   * sessionId is still validated against the bound session for
   * defence-in-depth, but that check lives in the handler, not here).
   *
   * Idempotent: clearing an unknown senderId is a no-op, so a
   * renderer that fires `auth:logout` twice in quick succession does
   * not see an error on the second call.
   */
  logout(senderId: SenderId): Promise<Result<void>> {
    // Sync body; wrapped in Promise.resolve so the surface stays uniform
    // with the other (genuinely async) AuthService methods.
    sessionStore.clear(senderId);
    return Promise.resolve(Ok(undefined));
  },
} as const;
