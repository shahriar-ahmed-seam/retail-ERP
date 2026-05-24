/**
 * Inventory feature barrel (tasks 5.4 + 5.5.2).
 *
 * Re-exports the inventory pages so the renderer entry (and the
 * upcoming router in task 13.1) can import them from
 * `@renderer/features/inventory` without referencing file paths
 * directly. Phase 5 ships the manual stock adjustment page (task 5.4)
 * alongside the Admin-only inventory movements browser (task 5.5.2).
 */

export { AdjustPage } from './AdjustPage';
export type { AdjustPageProps } from './AdjustPage';

export { MovementsBrowserPage } from './MovementsBrowserPage';
export type {
  MovementNavigationTarget,
  MovementsBrowserPageProps,
} from './MovementsBrowserPage';
