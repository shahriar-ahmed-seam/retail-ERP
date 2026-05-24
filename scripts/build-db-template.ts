// scripts/build-db-template.ts
//
// Bundled `shop.db` template build step (Phase 1, task 1.5).
//
// Purpose
// -------
// The packaged Electron installer ships a pre-migrated, pre-seeded SQLite
// file at `resources/shop.db.template`. On first launch the main process
// copies this template to `<userData>/shop.db` (Phase 16 first-run logic;
// Req 14.2, 14.8). Building the template ahead of time means the user
// never waits for migrations to run on a cold install, and there is no
// runtime dependency on the Prisma CLI on the target machine (Req 14.6).
//
// This script is the build step that produces that template. It is
// intentionally NOT wired into `npm run build` — that script is for the
// renderer/main/preload bundles and runs on every dev cycle. The template
// only needs to exist for the installer (`npm run dist`, Phase 16). A
// developer invokes this script via `npm run db:template`, and the
// installer pipeline will invoke the same script before electron-builder
// packages the `resources/` folder.
//
// What it does
// ------------
// 1. Cleans any prior `resources/shop.db.template` (and SQLite sidecar
//    files: `-journal`, `-wal`, `-shm`) and any leftover temp build dir.
// 2. Creates an empty staging file at `prisma/.template-build/shop.db`.
//    The path is intentionally inside `prisma/` so the relative
//    `DATABASE_URL=file:./.template-build/shop.db` is resolved by Prisma
//    against the schema directory exactly as documented.
// 3. Spawns `prisma migrate deploy` against the staging file. We use
//    `migrate deploy` (not `migrate dev`) so the build is non-interactive
//    and idempotent — it applies committed migration history without
//    prompting or generating new migrations.
// 4. Spawns `prisma db seed` against the same staging file. The seed
//    script (prisma/seed.ts) is idempotent and writes the Admin/Cashier
//    roles and the initial Setting rows.
// 5. Copies the staging file to `resources/shop.db.template`.
// 6. Verifies the produced file: non-empty AND begins with the SQLite
//    file format header so we fail fast if migration silently produced
//    a zero-byte file.
// 7. Cleans up the staging directory.
//
// The script fails loudly on any non-zero exit code from a child process
// or any I/O error. Cleanup of the staging dir runs in a `finally` block
// so a failed build does not leave stale state for the next run.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';

// --- Path layout -----------------------------------------------------------
//
// `process.cwd()` is the repo root because this script is invoked via the
// `db:template` npm script and npm always runs scripts from the package
// root. We assert that assumption explicitly so a developer running the
// script from the wrong directory gets a clear error instead of a
// confusing "schema.prisma not found" half-way through.

const repoRoot = process.cwd();

if (!existsSync(join(repoRoot, 'package.json'))) {
  throw new Error(
    `[build-db-template] expected to run from repo root; cwd=${repoRoot} ` +
      `does not contain package.json. Run via "npm run db:template".`,
  );
}
if (!existsSync(join(repoRoot, 'prisma', 'schema.prisma'))) {
  throw new Error(
    `[build-db-template] prisma/schema.prisma not found under cwd=${repoRoot}.`,
  );
}

const prismaDir = join(repoRoot, 'prisma');
const stagingDir = join(prismaDir, '.template-build');
const stagingDb = join(stagingDir, 'shop.db');
const resourcesDir = join(repoRoot, 'resources');
const templatePath = join(resourcesDir, 'shop.db.template');

// SQLite writes auxiliary files alongside the main DB depending on
// journal mode. Even though the staging build runs with the project's
// configured pragmas (WAL only kicks in after a connection applies it),
// any of these may exist from a prior failed run — clean them all.
const sidecarSuffixes = ['-journal', '-wal', '-shm'] as const;

// `DATABASE_URL` is interpreted by Prisma relative to the schema file's
// directory (`prisma/`), so this points at `prisma/.template-build/shop.db`.
const stagingDatabaseUrl = 'file:./.template-build/shop.db';

// --- Helpers ---------------------------------------------------------------

function log(message: string): void {
  // Plain stdout, no chalk — keeps the script free of extra dependencies
  // and works identically in dev terminals and CI logs.
  process.stdout.write(`[build-db-template] ${message}\n`);
}

/**
 * Remove a path if it exists. `rmSync` with `force: true` already silences
 * ENOENT, but wrapping it makes the intent explicit at the call site and
 * lets us swap implementations if we later need cross-version handling.
 */
function safeRemove(target: string): void {
  rmSync(target, { force: true, recursive: true });
}

/**
 * Run a child process synchronously, inheriting stdio so Prisma's progress
 * output reaches the developer. Throws on non-zero exit, including the
 * exit code in the error message for easier debugging.
 *
 * On Windows, executables installed by npm are exposed as `.cmd` shims
 * (e.g. `npx.cmd`). Since Node 18.20.2 / 20.12.2 / 22.x (CVE-2024-27980),
 * `spawnSync` refuses to invoke `.cmd` files without `shell: true`. We
 * therefore enable `shell: true` on Windows. The injection surface is
 * non-existent here: every argument passed to `runChild` is a hard-coded
 * literal in this script (no user input flows into the call), so the shell
 * cannot be steered toward an unintended command.
 */
function runChild(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  log(`$ ${bin} ${args.join(' ')}`);
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw new Error(
      `[build-db-template] failed to spawn ${bin}: ${result.error.message}`,
    );
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    throw new Error(
      `[build-db-template] ${bin} ${args.join(' ')} exited with status ` +
        `${result.status ?? 'null'} (signal=${result.signal ?? 'none'}).`,
    );
  }
}

/**
 * Verify the produced template file looks like a real SQLite database.
 *
 * SQLite database files start with the literal ASCII string
 * `SQLite format 3\0` (16 bytes). Checking the magic header guards
 * against the migration silently producing a zero-byte file or some
 * other corrupted artifact, without pulling in a SQLite native module
 * just for verification. Schema-level checks live in Phase 1 task 1.6
 * (integration test against a fresh DB).
 */
function verifySqliteFile(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`[build-db-template] expected output missing: ${path}`);
  }
  const size = statSync(path).size;
  if (size < 16) {
    throw new Error(
      `[build-db-template] output too small (${size} bytes) — migrations ` +
        `may not have run against ${path}.`,
    );
  }
  const expectedMagic = 'SQLite format 3\u0000';
  const buf = Buffer.alloc(16);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  if (buf.toString('utf8') !== expectedMagic) {
    throw new Error(
      `[build-db-template] output is not a SQLite database: ${path}`,
    );
  }
  log(`verified ${path} (${size.toLocaleString()} bytes, SQLite header OK)`);
}

// --- Main ------------------------------------------------------------------

function main(): void {
  log(`repo root: ${repoRoot}`);

  // 1. Clean prior outputs.
  log('cleaning prior template + staging files');
  safeRemove(templatePath);
  for (const suffix of sidecarSuffixes) {
    safeRemove(`${templatePath}${suffix}`);
  }
  safeRemove(stagingDir);

  // 2. Prepare staging + resources directories.
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  // 3. Compose the child-process environment. We deliberately copy the
  //    parent env (so PATH, NODE_OPTIONS, etc. flow through) and override
  //    only the database URL. The seed script reads `DATABASE_URL`
  //    directly via `new PrismaClient()`, and `prisma migrate deploy`
  //    reads it via the schema's `env("DATABASE_URL")` declaration.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: stagingDatabaseUrl,
  };

  try {
    // 4. Apply committed migrations. `migrate deploy` is the production
    //    pathway: it never prompts, never generates new migrations, and
    //    fails if the migration history is inconsistent — exactly the
    //    behavior we want for an installer build.
    runChild('npx', ['prisma', 'migrate', 'deploy'], childEnv);

    // 5. Run the seed. Goes through the `prisma.seed` field configured
    //    in package.json (-> `tsx prisma/seed.ts`). Idempotent.
    runChild('npx', ['prisma', 'db', 'seed'], childEnv);

    // 6. Copy the staging file to its final resting place. We copy
    //    rather than rename so that if the staging dir ends up on a
    //    different filesystem from `resources/` (rare on dev machines,
    //    common in some CI sandboxes) the operation still succeeds.
    log(`copying ${stagingDb} -> ${templatePath}`);
    copyFileSync(stagingDb, templatePath);

    // 7. Sanity-check the artifact.
    verifySqliteFile(templatePath);

    log('done.');
  } finally {
    // 8. Clean up the staging dir whether the build succeeded or failed.
    //    A failed build should not leave a half-migrated DB lying around
    //    that the next attempt would silently re-use. We do NOT remove
    //    the produced template here — on success it is the deliverable;
    //    on failure step 1 of the next run will clean it.
    safeRemove(stagingDir);
  }
}

try {
  main();
} catch (err) {
  // Log + non-zero exit. Re-throwing would print the same stack twice.
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
