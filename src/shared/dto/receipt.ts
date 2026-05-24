/**
 * Receipt DTO consumed by the printing pipeline (ESC/POS → HTML → PDF).
 *
 * The receipt is built from a committed `Sale` after the finalize
 * transaction returns, so every value here is a snapshot — never a live
 * join. Decimal columns are strings end-to-end to keep the printed totals
 * byte-for-byte identical to what was persisted on the sale.
 *
 * The full renderer (`src/main/printing/receipt.render.ts`) lands in
 * Phase 8 (task 8.1). Declaring the DTO here keeps the IPC contract
 * coherent — anything that takes or returns a receipt-shaped payload can
 * import this single type.
 *
 * Validates: Requirements 4.7, 4.8.
 */

import type { PaymentMethod } from './sale.js';

/** Shop info emitted at the top of every receipt. Sourced from
 *  `Setting`s (`shop.name`, `shop.address`, `shop.phone`). */
export interface ReceiptShopInfo {
  readonly name: string;
  readonly address: string;
  readonly phone: string;
}

/** A single line on the receipt. */
export interface ReceiptLine {
  readonly productName: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
}

/** A single payment captured against the sale. */
export interface ReceiptPayment {
  readonly method: PaymentMethod;
  readonly amount: string;
}

/** Complete payload required to render a receipt in any output format. */
export interface ReceiptDTO {
  readonly shop: ReceiptShopInfo;
  /** `INV-XXXXXX` per Req 4.3. */
  readonly serialNo: string;
  readonly cashierName: string;
  readonly customerName: string | null;
  readonly lines: readonly ReceiptLine[];
  readonly subtotal: string;
  readonly discount: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  readonly payments: readonly ReceiptPayment[];
  /** ISO 8601 timestamp from `Sale.createdAt`. */
  readonly timestamp: string;
}
