/**
 * Barrel for the shared DTOs that cross the IPC boundary.
 *
 * Every DTO is process-agnostic — no Node, DOM, or Prisma-runtime imports
 * — so the same module compiles into the main, preload, and renderer
 * tsconfigs. The IPC contract (`@shared/ipc-contract`) is the single
 * consumer that ties channels to these shapes.
 */

export type {
  AuditActionType,
  AuditFilter,
  AuditLogDTO,
  AuditSortKey,
} from './audit-log.js';

export type { CategoryDTO, CategoryInput } from './category.js';

export type {
  CustomerDTO,
  CustomerFilter,
  CustomerInput,
  CustomerSortKey,
} from './customer.js';

export type {
  AdjustmentInput,
  InventoryMovementDTO,
  MovementFilter,
  MovementSortKey,
  MovementType,
  ReferenceType,
} from './inventory-movement.js';

export type {
  JournalEntryDTO,
  JournalFilter,
  JournalOpType,
  JournalSortKey,
} from './journal-entry.js';

export type {
  ProductDTO,
  ProductFilter,
  ProductInput,
  ProductSortKey,
} from './product.js';

export type {
  PurchaseDTO,
  PurchaseInput,
  PurchaseItemDTO,
  PurchaseItemInput,
  PurchaseSummaryDTO,
  PurchasesFilter,
  PurchasesSortKey,
} from './purchase.js';

export type {
  ReceiptDTO,
  ReceiptLine,
  ReceiptPayment,
  ReceiptShopInfo,
} from './receipt.js';

export type {
  DailySalesPaymentBreakdownRow,
  DailySalesReport,
  LowStockRow,
  MonthlySalesReport,
  ReportExportFormat,
  ReportExportPaths,
  ReportExportRequest,
  ReportExportResponse,
  TopSellingRow,
} from './report.js';

export type {
  DiscountInput,
  FinalizeSaleInput,
  PaymentDTO,
  PaymentInput,
  PaymentMethod,
  SaleDTO,
  SaleItemDTO,
  SaleItemInput,
  SaleSummaryDTO,
  SalesFilter,
  SalesSortKey,
} from './sale.js';

export type {
  SupplierDTO,
  SupplierFilter,
  SupplierInput,
  SupplierSortKey,
} from './supplier.js';
