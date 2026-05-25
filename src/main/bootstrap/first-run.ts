// src/main/bootstrap/first-run.ts
//
// First-run database bootstrap (Phase 16, task 16.2).
//
// Responsibilities split into testable helpers so the bootstrap path
// is exercisable from `tests/unit/main/bootstrap/` without spinning
// up Electron, Prisma, or a real `BrowserWindow`:
//
//   1. `ensureUserDb({userDataDir, templatePath, fs?})` — copy the
//      bundled `resources/shop.db.template` to `<userData>/shop.db`
//      iff the destination does not yet exist (Req 14.2, 14.8). The
//      copy is the source of seeded roles + Setting rows on first
//      run; on subsequent launches the helper is a no-op so the
//      operator's data is preserved (the design's "Reinstall over
//      an existing install is safe" guarantee).
//
//   2. `runMigrations({databaseUrl, onProgress, spawnFn?})` — run
//      `prisma migrate deploy` against the user-data DB and pipe
//      progress events to the migration window. Implemented via
//      `child_process.spawn` so the migration runner does not
//      depend on the Prisma CLI being on the operator's PATH (the
//      packaged installer ships `node_modules/.bin/prisma` with
//      its own dependencies). On Windows we set `shell: true`
//      because npm-installed CLIs are exposed as `.cmd` shims that
//      Node's `spawn` refuses to invoke directly since CVE-2024-
//      27980. The argv passed below is fully literal — no user
//      input flows into it — so the `shell: true` mode has no
//      injection surface.
//
// Both helpers are pure with respect to Electron: they accept
// configuration via arguments and use `child_process.spawn` /
// `node:fs` directly, never `app.getPath`. The thin wrapper that
// drives the migration `BrowserWindow` lives in
// `src/main/index.ts`'s `bootstrapMain()` and is tested via the
// E2E tier (Phase 16's smoke test, Property 18).
//
// Validates: Requirements 14.1, 14.2, 14.8, 14.9.

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { MigrationProgressEvent } from '@shared/migration';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';

// ---------------------------------------------------------------------------
// ensureUserDb
// ---------------------------------------------------------------------------

/** Subset of `node:fs` we depend on — declared so tests can stub it. */
export interface FsLike {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  copyFileSync(src: string, dest: string): void;
}

const defaultFs: FsLike = { existsSync, mkdirSync, copyFileSync };

export interface EnsureUserDbInput {
  /** Resolved `<userData>` directory (Electron's `app.getPath('userData')`). */
  readonly userDataDir: string;
  /**
   * Absolute path to `resources/shop.db.template`. In production we
   * resolve via `process.resourcesPath`; tests pass a fixture path.
   */
  readonly templatePath: string;
  /** Override the file-system surface (tests). */
  readonly fs?: FsLike;
}

export interface EnsureUserDbResult {
  /** The absolute target path (`<userData>/shop.db`). */
  readonly dbPath: string;
  /** True when the template was copied; false when the DB already existed. */
  readonly copied: boolean;
}

/**
 * Ensure `<userData>/shop.db` exists. Copies the bundled template
 * over once, on first launch.
 *
 * The helper is intentionally synchronous: it runs before any
 * `BrowserWindow` is created, before Prisma is opened, and before
 * the IPC router is bound. Using the synchronous `node:fs` calls
 * keeps the bootstrap easy to reason about and avoids interleaving
 * the copy with Electron's `app.whenReady()` event loop quirks.
 */
export function ensureUserDb(input: EnsureUserDbInput): EnsureUserDbResult {
  const fs = input.fs ?? defaultFs;
  const dbPath = join(input.userDataDir, 'shop.db');

  if (fs.existsSync(dbPath)) {
    return { dbPath, copied: false };
  }

  if (!fs.existsSync(input.templatePath)) {
    throw new Error(
      `[bootstrap] missing bundled DB template at ${input.templatePath}`,
    );
  }

  // Make sure the userData directory exists. Electron's
  // `getPath('userData')` is created on first call in production;
  // tests against a temp dir need the parent directory to be
  // writable.
  const parent = dirname(dbPath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  fs.copyFileSync(input.templatePath, dbPath);
  return { dbPath, copied: true };
}

// ---------------------------------------------------------------------------
// runMigrations
// ---------------------------------------------------------------------------

/**
 * Subset of `child_process.spawn` we depend on. Returning the
 * `ChildProcessWithoutNullStreams` shape directly keeps the helper
 * trivial to drive from tests via a fake EventEmitter.
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface RunMigrationsInput {
  /** Absolute SQLite URL (`file:/abs/path/to/shop.db`). */
  readonly databaseUrl: string;
  /** Callback invoked for every progress event. */
  readonly onProgress: (event: MigrationProgressEvent) => void;
  /** Override `child_process.spawn` (tests). */
  readonly spawnFn?: SpawnLike;
  /**
   * Override the parent process's PATH/working directory env. Tests
   * set this to a deterministic snapshot; production uses
   * `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Working directory for the spawned process. Production uses the
   * resolved app root (so `prisma/schema.prisma` is discoverable);
   * tests pass a fixture root.
   */
  readonly cwd: string;
  /** Override `process.platform` (tests). Defaults to the running platform. */
  readonly platform?: NodeJS.Platform;
}

export interface RunMigrationsResult {
  readonly exitCode: number;
  /** Trailing stderr buffer for diagnostics on a non-zero exit. */
  readonly stderr: string;
  /** Trailing stdout buffer (may include the migration list). */
  readonly stdout: string;
}

/**
 * Pattern matched against each line of `prisma migrate deploy`'s
 * stdout to advance the progress events. The CLI prints a header
 * line of the form:
 *
 *   `1 migration found in prisma/migrations`
 *   `Applying migration `20260524073808_init``
 *
 * We use the `Applying migration` line (the exact wording the
 * Prisma CLI uses in `migrate deploy` output) to advance the
 * `current` counter from 1 upward; the `total` counter comes from
 * the leading "N migration(s) found" line. Both regexes are
 * intentionally permissive — we only want to drive UI progress, not
 * to reverse-engineer the CLI's exact format.
 */
const RE_TOTAL = /(\d+)\s+migrations?\s+found/i;
const RE_APPLYING = /Applying migration/i;

/**
 * Run `prisma migrate deploy` and surface progress events to the
 * caller. Resolves with the child's exit code; the caller is
 * responsible for treating a non-zero code as an error and emitting
 * the `error` progress event.
 *
 * The function deliberately does NOT throw on a non-zero exit — the
 * caller (`bootstrapMain`) needs to distinguish a clean failure
 * from a thrown infrastructure error so it can route to the
 * recovery flow correctly.
 */
export function runMigrations(input: RunMigrationsInput): Promise<RunMigrationsResult> {
  const spawnFn: SpawnLike = input.spawnFn ?? ((command, args, options) =>
    spawn(command, [...args], options));
  const platform = input.platform ?? process.platform;
  const onWindows = platform === 'win32';

  // Compose the child env. We override DATABASE_URL to point at the
  // user-data DB (so the same Prisma schema declaration that reads
  // `env("DATABASE_URL")` resolves to the right file at runtime),
  // and silence the Prisma CLI update banner so a long stdout line
  // doesn't disrupt our line-by-line progress parsing.
  const baseEnv = input.env ?? process.env;
  const childEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    DATABASE_URL: input.databaseUrl,
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
  };

  // Emit the `preparing` event up-front so the migration window
  // shows a stable copy while the child is still spinning up.
  input.onProgress({ phase: 'preparing' });

  return new Promise<RunMigrationsResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: input.cwd,
        env: childEnv,
        // Windows: shell: true so the .cmd shim is invoked. The
        // argv is fully literal — no user input flows into it.
        shell: onWindows,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let total = 0;
    let current = 0;

    const handleLine = (line: string): void => {
      // Total migration count — first line of the deploy output.
      const totalMatch = RE_TOTAL.exec(line);
      if (totalMatch?.[1] !== undefined) {
        const parsed = Number.parseInt(totalMatch[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          total = parsed;
        }
      }
      if (RE_APPLYING.test(line)) {
        current += 1;
        input.onProgress({
          phase: 'applying',
          current,
          // If we never matched the "N migrations found" line (e.g.
          // the CLI changed wording in a future version), report at
          // least the count so far. The UI clamps `current <= total`.
          total: total > 0 ? total : current,
        });
      }
    };

    const consumeChunk = (
      buffered: string,
      chunk: Buffer | string,
    ): string => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const combined = buffered + text;
      const lines = combined.split(/\r?\n/);
      // Last segment may be an incomplete line; keep it for the
      // next chunk.
      const trailing = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) handleLine(line);
      }
      return trailing;
    };

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stdoutBuf = consumeChunk(stdoutBuf, chunk);
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });

    child.on('error', (err: Error) => {
      reject(err);
    });

    child.on('close', (code: number | null) => {
      // Flush any trailing line that did not end in a newline.
      if (stdoutBuf.length > 0) handleLine(stdoutBuf);
      const exitCode = code ?? -1;
      resolve({ exitCode, stdout, stderr });
    });
  });
}
