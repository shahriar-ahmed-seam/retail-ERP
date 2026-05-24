/**
 * Customers feature barrel (task 9.2, Phase 9).
 *
 * Re-exports the customers list, form, and detail pages so the
 * renderer entry (and the upcoming router in task 13.1) can import
 * them from `@renderer/features/customers` without referencing file
 * paths directly. All three pages render standalone — they own their
 * own state and hit the IPC surface through `useApi()`.
 */

export { CustomersListPage } from './CustomersListPage';
export { CustomerFormPage } from './CustomerFormPage';
export type { CustomerFormPageProps } from './CustomerFormPage';
export { CustomerDetailPage } from './CustomerDetailPage';
export type { CustomerDetailPageProps } from './CustomerDetailPage';
