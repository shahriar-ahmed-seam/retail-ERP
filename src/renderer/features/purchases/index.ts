/**
 * Purchases feature barrel (task 6.3, Phase 6).
 *
 * Re-exports the purchase create + read-only purchases list pages so
 * the renderer entry (and the upcoming router in task 13.1) can import
 * them from `@renderer/features/purchases` without referencing file
 * paths directly. Both pages render standalone — they own their own
 * state and hit the IPC surface through `useApi()`.
 */

export { PurchaseCreatePage } from './PurchaseCreatePage';
export type { PurchaseCreatePageProps } from './PurchaseCreatePage';

export { PurchasesListPage } from './PurchasesListPage';
