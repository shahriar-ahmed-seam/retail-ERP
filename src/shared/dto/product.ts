/**
 * Product DTOs and input shapes used across the IPC boundary.
 *
 * Decimal columns (`buyPrice`, `sellPrice`, `taxRate`) are serialized as
 * strings end-to-end. Prisma's `Decimal` type does not round-trip cleanly
 * through Electron's structured clone, and JS `number` cannot represent
 * fixed-point monetary values for the full register lifecycle without
 * accumulating drift. The renderer parses these on display via a shared
 * money helper (introduced alongside the totals math in Phase 7).
 *
 * The `onHand` integer is denormalized from `Inventory.onHand` and joined
 * by `ProductService.list` so the renderer can render the products list
 * without a second round-trip per row. Per the inventory ledger invariant
 * (design.md > "Inventory Ledger Invariant", Property 1) this number is
 * always equal to `sum(InventoryMovement.quantityDelta)` for the product
 * at the moment the row was selected.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 3.6.
 */

/** A product as returned by `products:list`, `products:upsert`, `pos:scan`. */
export interface ProductDTO {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryId: string;
  /** Joined display name; absent if the consumer did not opt in to the join. */
  readonly categoryName?: string;
  /** Optional barcode; `null` when the product has none assigned (Req 2.3). */
  readonly barcode: string | null;
  /** Decimal serialized as a fixed-precision string. */
  readonly buyPrice: string;
  /** Decimal serialized as a fixed-precision string. */
  readonly sellPrice: string;
  /** Decimal serialized as a fixed-precision string (e.g. `"0.18"`). */
  readonly taxRate: string;
  readonly warrantyMonths: number;
  readonly reorderLevel: number;
  /** Joined from `Inventory.onHand` (Req 3.2, 3.6, 11.4). */
  readonly onHand: number;
}

/**
 * Request payload for `products:upsert`. Omit `id` to create; supply `id`
 * to update an existing record.
 *
 * `barcode` is `string | null` — the renderer must explicitly clear a
 * previously assigned barcode by sending `null`. Not setting the property
 * leaves the existing value alone (handler-side merge logic enforces this
 * to honour `exactOptionalPropertyTypes`).
 */
export interface ProductInput {
  readonly id?: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryId: string;
  readonly barcode?: string | null;
  readonly buyPrice: string;
  readonly sellPrice: string;
  readonly taxRate: string;
  readonly warrantyMonths: number;
  readonly reorderLevel: number;
}

/** Filter accepted by `products:list` and `products:count`. */
export interface ProductFilter {
  readonly categoryId?: string;
  readonly lowStockOnly?: boolean;
}

/** Sort keys accepted by `products:list`. */
export type ProductSortKey = 'name' | 'sku' | 'createdAt';
