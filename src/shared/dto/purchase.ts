/**
 * Purchase DTOs and inputs for `purchase:create` and `purchases:list`.
 *
 * `PurchaseSummaryDTO` is the list-page row; the full purchase record
 * (header + items) is fetched via the supplier detail channel and the
 * planned `purchases:detail` channel (added in a later phase). Decimal
 * columns are strings end-to-end (see `dto/product.ts`).
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 6.3.
 */

export interface PurchaseItemInput {
  readonly productId: string;
  readonly quantity: number;
  readonly unitBuyPrice: string;
}

export interface PurchaseInput {
  readonly supplierId: string;
  readonly invoiceNo?: string | null;
  readonly items: readonly PurchaseItemInput[];
}

export interface PurchaseItemDTO {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitBuyPrice: string;
  /** Persisted; equal to `quantity * unitBuyPrice` (line_total identity). */
  readonly lineTotal: string;
}

export interface PurchaseDTO {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly invoiceNo: string | null;
  readonly total: string;
  readonly createdAt: string;
  readonly items: readonly PurchaseItemDTO[];
}

/** List-page summary returned by `purchases:list`. */
export interface PurchaseSummaryDTO {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly invoiceNo: string | null;
  readonly total: string;
  readonly itemCount: number;
  readonly createdAt: string;
}

export interface PurchasesFilter {
  readonly supplierId?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export type PurchasesSortKey = 'createdAt';
