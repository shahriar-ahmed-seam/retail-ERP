/**
 * Suppliers feature barrel (task 6.1, Phase 6).
 *
 * Re-exports the suppliers list, form, and detail pages so the
 * renderer entry (and the upcoming router in task 13.1) can import
 * them from `@renderer/features/suppliers` without referencing file
 * paths directly. All three pages render standalone — they own their
 * own state and hit the IPC surface through `useApi()`.
 */

export { SuppliersListPage } from './SuppliersListPage';
export { SupplierFormPage } from './SupplierFormPage';
export type { SupplierFormPageProps } from './SupplierFormPage';
export { SupplierDetailPage } from './SupplierDetailPage';
export type { SupplierDetailPageProps } from './SupplierDetailPage';
