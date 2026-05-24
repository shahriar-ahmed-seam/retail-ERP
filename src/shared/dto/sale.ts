/**
 * Sale DTOs and inputs for `pos:finalize` and `sales:list`.
 *
 * Two response shapes:
 *  - `SaleSummaryDTO` is what `sales:list` returns: one row per sale, with
 *    just enough fields to fill a virtualized list (no items, no payments).
 *    Joining the customer name and cashier name here saves a per-row
 *    follow-up IPC and is bounded by the channel's `pageSize` cap.
 *  - `SaleDTO` is the full receipt: header + items[] + payments[]. It is
 *    used by `sales:detail` (added later) and as the receipt source.
 *
 * Decimal columns are strings end-to-end; see `dto/product.ts` for the
 * rationale.
 *
 * Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 7.2, 7.4.
 */

/** Payment method discriminator (Req 4.6). */
export type PaymentMethod = 'cash' | 'card' | 'mobile';

/** A single line on a sale. */
export interface SaleItemDTO {
  readonly id: string;
  readonly productId: string;
  /** Joined display name (snapshot at sale time would be safer; left as a
   *  current join here because Product.name is rarely mutated and we have
   *  the original sellPrice locked on the line). */
  readonly productName: string;
  readonly quantity: number;
  /** `Product.sellPrice` at the time of sale (Req 4.4). */
  readonly unitPrice: string;
  /** `Product.taxRate` at the time of sale (Req 2.6, 4.5). */
  readonly taxRate: string;
  /** `quantity * unitPrice`, pre-discount, pre-tax (Req 4.4). */
  readonly lineTotal: string;
}

/** A single payment captured against a sale. */
export interface PaymentDTO {
  readonly id: string;
  readonly method: PaymentMethod;
  readonly amount: string;
}

/** Full sale record (header + items + payments). */
export interface SaleDTO {
  readonly id: string;
  /** Per-shop monotonic invoice number, format `INV-XXXXXX` (Req 4.3). */
  readonly serialNo: string;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly cashierId: string;
  readonly cashierName: string;
  readonly subtotal: string;
  readonly discount: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  /** ISO 8601 timestamp from `Sale.createdAt` (Req 16.4 cursor sort). */
  readonly createdAt: string;
  readonly items: readonly SaleItemDTO[];
  readonly payments: readonly PaymentDTO[];
}

/** List-page summary returned by `sales:list`. */
export interface SaleSummaryDTO {
  readonly id: string;
  readonly serialNo: string;
  readonly grandTotal: string;
  readonly customerName: string | null;
  readonly cashierName: string;
  readonly createdAt: string;
}

/** Discount may be applied as a fixed monetary amount or a percentage (Req 4.5). */
export type DiscountInput =
  | { readonly kind: 'fixed'; readonly amount: string }
  | { readonly kind: 'percent'; readonly percent: string };

/** A single cart line submitted to `pos:finalize`. */
export interface SaleItemInput {
  readonly productId: string;
  readonly quantity: number;
  /** Renderer-supplied; main re-validates against `Product.sellPrice`. */
  readonly unitPrice: string;
  readonly taxRate: string;
  readonly lineTotal: string;
}

/** A payment submitted with a sale. */
export interface PaymentInput {
  readonly method: PaymentMethod;
  readonly amount: string;
}

/**
 * Request payload for `pos:finalize`. The renderer ships its computed
 * totals; the main process re-runs `validateTotalsIdentity` inside the
 * transaction (Property 2).
 */
export interface FinalizeSaleInput {
  readonly customerId?: string | null;
  readonly items: readonly SaleItemInput[];
  readonly discount: DiscountInput;
  readonly subtotal: string;
  readonly discountAmount: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  readonly payments: readonly PaymentInput[];
}

/** Filter accepted by `sales:list` and `sales:count`. */
export interface SalesFilter {
  readonly cashierId?: string;
  readonly customerId?: string;
  /** ISO date string (`YYYY-MM-DD`) or full ISO timestamp; inclusive lower bound. */
  readonly dateFrom?: string;
  /** ISO date string or full ISO timestamp; exclusive upper bound. */
  readonly dateTo?: string;
}

export type SalesSortKey = 'createdAt' | 'serialNo';
