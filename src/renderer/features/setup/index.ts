/**
 * Setup feature barrel (task 3.4).
 *
 * Re-exports the initial admin setup screen so the renderer entry can
 * import it from `@renderer/features/setup` without referencing the
 * file directly.
 */

export { SetupPage } from './SetupPage.js';
export {
  MigrationProgressPage,
  progressTextFor,
  type MigrationProgressPageProps,
  type MigrationProgressSubscriber,
} from './MigrationProgressPage.js';
