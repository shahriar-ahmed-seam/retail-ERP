// Renderer-shared components barrel.
//
// `VirtualizedTable` (and its data hook `usePaginatedList`) is the reuse
// target for every paginated list view in the app — products, customers,
// suppliers, sales, purchases, inventory_movements, audit, journal, and
// any reports preview that can exceed 200 rows (Req 16.5).

export {
  usePaginatedList,
  VirtualizedTable,
  type CountChannelFor,
  type ListFilterOf,
  type ListRowOf,
  type ListSortOf,
  type PaginatedListChannel,
  type UsePaginatedListParams,
  type UsePaginatedListResult,
  type VirtualizedTableProps,
} from './VirtualizedTable';

export { LowStockBanner } from './LowStockBanner';
export type { LowStockBannerProps } from './LowStockBanner';

export { ToastBridge } from './ToastBridge';

export { TitleBar, TITLE_BAR_HEIGHT } from './TitleBar';
export type { TitleBarProps } from './TitleBar';
