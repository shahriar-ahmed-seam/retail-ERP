/**
 * Settings feature barrel (Phase 8, task 8.6).
 *
 * Re-exports the settings pages so the renderer entry (and the
 * upcoming role-aware shell in task 13.1) can import them from
 * `@renderer/features/settings` without referencing file paths
 * directly. Phase 8 ships the printer configuration page; future
 * phases extend this folder with shop info, backup retention, and
 * the audit-log viewer (each Admin-only).
 */

export { PrinterSettingsPage } from './PrinterSettingsPage';
