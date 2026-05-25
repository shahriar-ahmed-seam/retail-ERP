/**
 * Unit tests for the first-run database bootstrap helpers (Phase 16,
 * task 16.2).
 *
 * Drives `ensureUserDb` and `runMigrations` against in-memory stubs
 * for `node:fs` and `child_process.spawn` so the helpers can be
 * exercised without copying real files or running the Prisma CLI.
 *
 * Coverage:
 *   - `ensureUserDb` copies the bundled template when the DB is
 *     missing.
 *   - `ensureUserDb` is a no-op when the DB already exists.
 *   - `ensureUserDb` throws when the bundled template is missing.
 *   - `runMigrations` emits `preparing` immediately and `applying`
 *     events when stdout reports `Applying migration` lines.
 *   - `runMigrations` parses the "N migrations found" header and
 *     sets `total` accordingly.
 *   - `runMigrations` resolves with the child's exit code.
 *   - `runMigrations` sets `DATABASE_URL` and `PRISMA_HIDE_UPDATE_MESSAGE`
 *     on the spawned env.
 *   - `runMigrations` sets `shell: true` on Windows.
 *   - `runMigrations` rejects when `spawn` throws or emits `error`.
 *
 * Validates: Requirements 14.1, 14.2, 14.8, 14.9.
 */

import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ensureUserDb,
  runMigrations,
  type FsLike,
  type SpawnLike,
} from '@main/bootstrap/first-run';

import type { MigrationProgressEvent } from '@shared/migration';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';

// ---------------------------------------------------------------------------
// FsLike stub
// ---------------------------------------------------------------------------

interface FsStubState {
  files: Set<string>;
  dirs: Set<string>;
  copies: { src: string; dest: string }[];
}

function makeFs(initial: { files?: string[]; dirs?: string[] } = {}): {
  fs: FsLike;
  state: FsStubState;
} {
  const state: FsStubState = {
    files: new Set(initial.files ?? []),
    dirs: new Set(initial.dirs ?? []),
    copies: [],
  };
  const fs: FsLike = {
    existsSync(p) {
      return state.files.has(p) || state.dirs.has(p);
    },
    mkdirSync(p) {
      state.dirs.add(p);
    },
    copyFileSync(src, dest) {
      state.copies.push({ src, dest });
      state.files.add(dest);
    },
  };
  return { fs, state };
}

describe('ensureUserDb', () => {
  it('copies the bundled template to <userData>/shop.db on first run', () => {
    const { fs, state } = makeFs({
      files: ['/resources/shop.db.template'],
      dirs: ['/userData'],
    });

    const result = ensureUserDb({
      userDataDir: '/userData',
      templatePath: '/resources/shop.db.template',
      fs,
    });

    // Path uses the platform separator; both forward and backslash
    // joins are acceptable. Compare case-insensitively against the
    // expected components.
    expect(result.copied).toBe(true);
    expect(result.dbPath).toMatch(/userData[\\/]shop\.db$/);
    expect(state.copies).toHaveLength(1);
    expect(state.copies[0]?.src).toBe('/resources/shop.db.template');
    expect(state.copies[0]?.dest).toBe(result.dbPath);
  });

  it('is a no-op when the DB file already exists', () => {
    const dbPath = join('/userData', 'shop.db');
    const { fs, state } = makeFs({
      files: ['/resources/shop.db.template', dbPath],
      dirs: ['/userData'],
    });

    const result = ensureUserDb({
      userDataDir: '/userData',
      templatePath: '/resources/shop.db.template',
      fs,
    });

    expect(result.copied).toBe(false);
    expect(state.copies).toHaveLength(0);
  });

  it('creates the parent directory when it does not exist', () => {
    const { fs, state } = makeFs({
      files: ['/resources/shop.db.template'],
    });

    const result = ensureUserDb({
      userDataDir: '/missing-parent',
      templatePath: '/resources/shop.db.template',
      fs,
    });

    expect(result.copied).toBe(true);
    // The helper joins `userDataDir + 'shop.db'` and then calls
    // `mkdirSync(dirname(joined))`. Recompute the expected path the
    // same way so the assertion matches the platform-specific
    // separator (Windows uses `\\`, POSIX uses `/`).
    const expectedParent = dirname(join('/missing-parent', 'shop.db'));
    expect(state.dirs.has(expectedParent)).toBe(true);
  });

  it('throws when the bundled template is missing', () => {
    const { fs } = makeFs({ dirs: ['/userData'] });

    expect(() =>
      ensureUserDb({
        userDataDir: '/userData',
        templatePath: '/resources/shop.db.template',
        fs,
      }),
    ).toThrow(/missing bundled DB template/i);
  });
});

// ---------------------------------------------------------------------------
// runMigrations stub harness
// ---------------------------------------------------------------------------

class FakeReadable extends EventEmitter {
  /* eslint-disable-next-line @typescript-eslint/no-empty-function */
  pause(): void {}
  /* eslint-disable-next-line @typescript-eslint/no-empty-function */
  resume(): void {}
}

class FakeChild extends EventEmitter {
  readonly stdout: FakeReadable;
  readonly stderr: FakeReadable;
  constructor() {
    super();
    this.stdout = new FakeReadable();
    this.stderr = new FakeReadable();
  }
  emitStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text, 'utf8'));
  }
  emitStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text, 'utf8'));
  }
  exit(code: number | null): void {
    this.emit('close', code);
  }
}

interface SpawnCapture {
  command?: string;
  args?: readonly string[];
  options?: SpawnOptionsWithoutStdio;
  child?: FakeChild;
}

function makeSpawn(): { spawn: SpawnLike; capture: SpawnCapture } {
  const capture: SpawnCapture = {};
  const spawn: SpawnLike = (command, args, options) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    const child = new FakeChild();
    capture.child = child;
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawn, capture };
}

describe('runMigrations', () => {
  it('emits a preparing event before the child writes anything', async () => {
    const { spawn, capture } = makeSpawn();
    const events: MigrationProgressEvent[] = [];

    const promise = runMigrations({
      databaseUrl: 'file:/tmp/x.db',
      cwd: '/repo',
      onProgress: (e) => events.push(e),
      spawnFn: spawn,
      env: { PATH: '/bin' },
      platform: 'linux',
    });

    expect(events[0]).toEqual({ phase: 'preparing' });

    capture.child!.exit(0);
    await promise;
  });

  it('counts each "Applying migration" line and reports total from the header', async () => {
    const { spawn, capture } = makeSpawn();
    const events: MigrationProgressEvent[] = [];

    const promise = runMigrations({
      databaseUrl: 'file:/tmp/x.db',
      cwd: '/repo',
      onProgress: (e) => events.push(e),
      spawnFn: spawn,
      env: { PATH: '/bin' },
      platform: 'linux',
    });

    capture.child!.emitStdout('3 migrations found in prisma/migrations\n');
    capture.child!.emitStdout('Applying migration `20260524073808_init`\n');
    capture.child!.emitStdout('Applying migration `20260524073809_two`\n');
    capture.child!.emitStdout('Applying migration `20260524073810_three`\n');
    capture.child!.exit(0);
    await promise;

    const applyEvents = events.filter((e) => e.phase === 'applying');
    expect(applyEvents).toEqual([
      { phase: 'applying', current: 1, total: 3 },
      { phase: 'applying', current: 2, total: 3 },
      { phase: 'applying', current: 3, total: 3 },
    ]);
  });

  it('handles a single migration when "1 migration found" is reported', async () => {
    const { spawn, capture } = makeSpawn();
    const events: MigrationProgressEvent[] = [];

    const promise = runMigrations({
      databaseUrl: 'file:/tmp/x.db',
      cwd: '/repo',
      onProgress: (e) => events.push(e),
      spawnFn: spawn,
      env: { PATH: '/bin' },
      platform: 'linux',
    });

    capture.child!.emitStdout('1 migration found in prisma/migrations\n');
    capture.child!.emitStdout('Applying migration `20260524073808_init`\n');
    capture.child!.exit(0);
    await promise;

    const applyEvents = events.filter((e) => e.phase === 'applying');
    expect(applyEvents).toEqual([
      { phase: 'applying', current: 1, total: 1 },
    ]);
  });

  it('resolves with the child exit code and captured stderr', async () => {
    const { spawn, capture } = makeSpawn();

    const promise = runMigrations({
      databaseUrl: 'file:/tmp/x.db',
      cwd: '/repo',
      onProgress: () => undefined,
      spawnFn: spawn,
      env: { PATH: '/bin' },
      platform: 'linux',
    });

    capture.child!.emitStderr('Error: P3009: migrate found failed migrations\n');
    capture.child!.exit(1);
    const result = await promise;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('P3009');
  });

  it('overrides DATABASE_URL and silences the Prisma update banner', async () => {
    const { spawn, capture } = makeSpawn();

    const promise = runMigrations({
      databaseUrl: 'file:/tmp/x.db',
      cwd: '/repo',
      onProgress: () => undefined,
      spawnFn: spawn,
      env: { PATH: '/bin', DATABASE_URL: 'file:/old.db' },
      platform: 'linux',
    });

    capture.child!.exit(0);
    await promise;

    expect(capture.options?.env).toMatchObject({
      DATABASE_URL: 'file:/tmp/x.db',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      PATH: '/bin',
    });
  });

  it('uses shell: true on Windows', async () => {
    const { spawn, capture } = makeSpawn();

    const promise = runMigrations({
      databaseUrl: 'file:/tmp/x.db',
      cwd: '/repo',
      onProgress: () => undefined,
      spawnFn: spawn,
      env: { PATH: 'C:\\WINDOWS' },
      platform: 'win32',
    });

    capture.child!.exit(0);
    await promise;

    expect(capture.options?.shell).toBe(true);
    expect(capture.command).toBe('npx');
    expect(capture.args).toEqual(['prisma', 'migrate', 'deploy']);
  });

  it('does not use a shell on POSIX platforms', async () => {
    const { spawn, capture } = makeSpawn();

    const promise = runMigrations({
      databaseUrl: 'file:/tmp/x.db',
      cwd: '/repo',
      onProgress: () => undefined,
      spawnFn: spawn,
      env: { PATH: '/bin' },
      platform: 'darwin',
    });

    capture.child!.exit(0);
    await promise;

    expect(capture.options?.shell).toBe(false);
  });

  it('rejects when spawn throws synchronously', async () => {
    const failing: SpawnLike = () => {
      throw new Error('ENOENT npx');
    };

    await expect(
      runMigrations({
        databaseUrl: 'file:/tmp/x.db',
        cwd: '/repo',
        onProgress: () => undefined,
        spawnFn: failing,
        env: { PATH: '/bin' },
        platform: 'linux',
      }),
    ).rejects.toThrow(/ENOENT npx/);
  });

  it('rejects when the child emits an error event', async () => {
    const { spawn, capture } = makeSpawn();

    const promise = runMigrations({
      databaseUrl: 'file:/tmp/x.db',
      cwd: '/repo',
      onProgress: () => undefined,
      spawnFn: spawn,
      env: { PATH: '/bin' },
      platform: 'linux',
    });

    capture.child!.emit('error', new Error('child boom'));
    await expect(promise).rejects.toThrow(/child boom/);
  });

  it('flushes a trailing line that did not end in a newline', async () => {
    const { spawn, capture } = makeSpawn();
    const events: MigrationProgressEvent[] = [];

    const promise = runMigrations({
      databaseUrl: 'file:/tmp/x.db',
      cwd: '/repo',
      onProgress: (e) => events.push(e),
      spawnFn: spawn,
      env: { PATH: '/bin' },
      platform: 'linux',
    });

    // No trailing newline on the final chunk; the close handler
    // should still emit one applying event.
    capture.child!.emitStdout('1 migration found\nApplying migration `init`');
    capture.child!.exit(0);
    await promise;

    const applyEvents = events.filter((e) => e.phase === 'applying');
    expect(applyEvents).toEqual([
      { phase: 'applying', current: 1, total: 1 },
    ]);
  });
});
