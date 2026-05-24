/**
 * Products feature barrel (task 4.4).
 *
 * Re-exports the products list and form pages so the renderer entry
 * (and the upcoming router in task 13.1) can import them from
 * `@renderer/features/products` without referencing the file paths
 * directly. Both pages render standalone — they own their own state
 * and hit the IPC surface through `useApi()`.
 */

export { ProductsListPage } from './ProductsListPage';
export { ProductFormPage } from './ProductFormPage';
export type { ProductFormPageProps } from './ProductFormPage';
