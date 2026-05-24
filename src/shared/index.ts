// Barrel for shared (cross-process) modules.
//
// Process-agnostic types and helpers consumed by main, preload, renderer,
// and tests. The IPC contract (task 2.2) and DTOs (task 2.2) live under
// `./ipc-contract.ts` and `./dto/`.

// Result envelope (task 2.1)
export {
  Err,
  Ok,
  UnwrapError,
  isErr,
  isOk,
  match,
  unwrap,
  type ErrOptions,
  type ErrResult,
  type ErrorCode,
  type ErrorEnvelope,
  type OkResult,
  type Result,
} from './result.js';

// Cursor encode/decode + page-size clamp (task 2.10)
export {
  CursorDecodeError,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  type CursorInput,
  type CursorPayload,
} from './cursor.js';

// POS totals math (task 7.1) — shared by renderer (live cart totals) and
// main process (`pos:finalize` re-validation inside the transaction).
export {
  applyDiscount,
  computeGrandTotal,
  computeSubtotal,
  computeTaxTotal,
  validateTotalsIdentity,
  type TotalsItem,
  type TotalsValidation,
  type ValidateTotalsOptions,
} from './pos-totals.js';

// IPC contract — single source of truth for every channel between
// renderer and main. Re-exports the pagination envelopes alongside the
// `IpcContract` type itself (task 2.2).
export { IPC_CHANNELS } from './ipc-contract.js';
export type {
  Api,
  DailySalesReport,
  IpcChannel,
  IpcContract,
  IpcRequest,
  IpcResponse,
  ListRequest,
  ListResponse,
  LowStockRow,
  MonthlySalesReport,
  ReportExportRequest,
  SessionDTO,
  SessionRole,
  SettingValue,
  TopSellingRow,
  UserDTO,
  UserUpsertInput,
} from './ipc-contract.js';

// DTOs that cross the IPC boundary (task 2.2).
export type {
  AdjustmentInput,
  AuditActionType,
  AuditFilter,
  AuditLogDTO,
  AuditSortKey,
  CustomerDTO,
  CustomerFilter,
  CustomerInput,
  CustomerSortKey,
  DiscountInput,
  FinalizeSaleInput,
  InventoryMovementDTO,
  JournalEntryDTO,
  JournalFilter,
  JournalOpType,
  JournalSortKey,
  MovementFilter,
  MovementSortKey,
  MovementType,
  PaymentDTO,
  PaymentInput,
  PaymentMethod,
  ProductDTO,
  ProductFilter,
  ProductInput,
  ProductSortKey,
  PurchaseDTO,
  PurchaseInput,
  PurchaseItemDTO,
  PurchaseItemInput,
  PurchaseSummaryDTO,
  PurchasesFilter,
  PurchasesSortKey,
  ReceiptDTO,
  ReceiptLine,
  ReceiptPayment,
  ReceiptShopInfo,
  ReferenceType,
  SaleDTO,
  SaleItemDTO,
  SaleItemInput,
  SaleSummaryDTO,
  SalesFilter,
  SalesSortKey,
  SupplierDTO,
  SupplierFilter,
  SupplierInput,
  SupplierSortKey,
} from './dto/index.js';
