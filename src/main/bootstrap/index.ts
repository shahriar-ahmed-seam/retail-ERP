/**
 * Barrel for main-process bootstrap helpers.
 *
 * Currently exposes the first-run database bootstrap from Phase 16
 * task 16.2; future helpers (e.g. recovery dispatchers, scheduler
 * wiring) plug in here so `src/main/index.ts` can import the whole
 * bootstrap surface from one location.
 */

export {
  ensureUserDb,
  runMigrations,
  type EnsureUserDbInput,
  type EnsureUserDbResult,
  type FsLike,
  type RunMigrationsInput,
  type RunMigrationsResult,
  type SpawnLike,
} from './first-run.js';
