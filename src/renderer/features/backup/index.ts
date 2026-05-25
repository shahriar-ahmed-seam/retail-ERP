/**
 * Backup feature barrel (Phase 11, task 11.7).
 *
 * Re-exports the backup management page so the renderer entry
 * (and the upcoming role-aware shell in task 13.1) can import it
 * from `@renderer/features/backup` without referencing file paths
 * directly.
 */

export { BackupPage } from './BackupPage';
