/**
 * POS feature barrel (tasks 7.5 + 7.6, Phase 7).
 *
 * Re-exports the cashier-facing POS page so the renderer entry (and the
 * upcoming router in task 13.1) can import it from
 * `@renderer/features/pos` without referencing file paths directly. The
 * page renders standalone — it owns its own cart state and hits the IPC
 * surface through `useApi()`.
 */

export { POSPage } from './POSPage';
export type { POSPageProps } from './POSPage';
