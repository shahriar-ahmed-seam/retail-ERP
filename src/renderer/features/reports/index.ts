/**
 * Reports feature barrel (task 10.8, Phase 10).
 *
 * Re-exports the four V1 report pages so the renderer entry (and the
 * upcoming router in task 13.1) can import them from
 * `@renderer/features/reports` without referencing file paths
 * directly. Each page renders standalone — they own their own state
 * and hit the IPC surface through `useApi()`.
 */

export { DailySalesPage } from './DailySalesPage';
export { MonthlySalesPage } from './MonthlySalesPage';
export { LowStockReportPage } from './LowStockReportPage';
export { TopSellingReportPage } from './TopSellingReportPage';
