/**
 * Receipt DTO consumed by the printing pipeline (ESC/POS → HTML → PDF).
 *
 * The receipt is built from a committed `Sale` after the finalize
 * transaction returns, so every value here is a snapshot — never a live
 * join. Decimal columns are strings end-to-end to keep the printed totals
 * byte-for-byte identical to what was persisted on the sale (same rule
 * that governs `ProductDTO` and `SaleDTO`).
 *
 * The renderer (`src/main/printing/receipt-renderer.ts`) is a pure
 * mapping from `SaleDTO` + `ReceiptShopInfo` to this shape — it owns no
 * I/O. Settings-row reads happen through `loadShopInfoFromSettings`
 * which the caller invokes once per print and passes in alongside the
 * sale.
 *
 * The DTO is process-agnostic: no Node, DOM, or Prisma-runtime imports,
 * so the same module compiles against the main, preload, and renderer
 * tsconfigs (all three include the shared folder).
 *
 * Validates: Requirements 4.7, 4.8.
 */

import type { PaymentMethod } from './sale.js';

/**
 * Shop info emitted at the top of every receipt.
 *
 * Sourced from four well-known `Setting` rows: `shop.name`,
 * `shop.address`, `shop.phone`, `shop.taxId`. `name` is required and
 * defaults to `'Shop'` when the setting is missing or empty; the other
 * three are `null` when unset so the renderer can omit the line rather
 * than print an empty placeholder.
 */
export interface ReceiptShopInfo {
  readonly name: string;
  readonly address: string | null;
  readonly phone: string | null;
  readonly taxId: string | null;
}

/**
 * A single line on the receipt.
 *
 * `name` is the product display name snapshotted at print time (the
 * same value that came back on `SaleItemDTO.productName`). `unitPrice`,
 * `lineTotal`, and `taxRate` are the persisted decimal strings — never
 * recomputed in the renderer — so the printed receipt and the DB row
 * are guaranteed to match digit-for-digit.
 */
export interface ReceiptLine {
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
  readonly taxRate: string;
}

/** A single payment captured against the sale. */
export interface ReceiptPayment {
  readonly method: PaymentMethod;
  readonly amount: string;
}

/** Complete payload required to render a receipt in any output format. */
export interface ReceiptDTO {
  readonly shopInfo: ReceiptShopInfo;
  /** `INV-XXXXXX` per Req 4.3. */
  readonly serialNo: string;
  /** ISO 8601 timestamp from `Sale.createdAt`. */
  readonly createdAt: string;
  readonly cashierName: string;
  readonly customerName: string | null;
  readonly lines: readonly ReceiptLine[];
  readonly subtotal: string;
  readonly discount: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  readonly payments: readonly ReceiptPayment[];
}
