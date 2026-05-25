/**
 * Journal entry DTO.
 *
 * `JournalEntry` is the append-only transaction log used for
 * snapshot-and-replay recovery (Req 10.4–10.6). The persisted `payload`
 * is a JSON string sufficient to replay the operation through the same
 * domain service that originally wrote it.
 *
 * The list channel `journal_entries:list` is Admin-only debug surface
 * (per the task list); the DTO surfaces `payload` as `unknown` so a
 * generic JSON tree viewer can render any opType without a per-type
 * switch in the service.
 *
 * ---------------------------------------------------------------------------
 * Per-opType payload schema
 * ---------------------------------------------------------------------------
 * Each business `$transaction` ends with exactly one `journal_entries`
 * insert (Req 10.4). The shape of the JSON `payload` column is fixed
 * per `opType` so the future replay handler can branch on the
 * discriminator and read uniform fields. All decimal money values are
 * stringified at write time to survive JSON round-tripping without
 * precision loss; all timestamps are ISO-8601 UTC strings captured
 * inside the same transaction so the payload is self-contained
 * regardless of how the row's own `timestamp` column evolves.
 *
 * The schemas below document the contract enforced by the writers:
 *   - `pos.service.ts#finalizeSale`     → `opType: 'sale'`
 *   - `purchase.service.ts#create`      → `opType: 'purchase'`
 *   - `inventory.service.ts#adjust`     → `opType: 'adjustment'`
 *   - `product.service.ts#upsert` (price-change branch)
 *                                       → `opType: 'price.change'`
 *   - `auth.service.ts#assignRole` (task 12.2) → `opType: 'role.change'`
 *
 * `SalePayload`:
 * ```ts
 * {
 *   saleId: string;          // deterministic primary key for replay upsert
 *   serialNo: string;        // monotonic INV-XXXXXX identifier
 *   customerId: string | null;
 *   cashierId: string;
 *   subtotal: string;        // decimal string
 *   discount: string;        // resolved discount AMOUNT, decimal string
 *   taxTotal: string;        // decimal string
 *   grandTotal: string;      // decimal string
 *   items: Array<{
 *     productId: string;
 *     quantity: number;      // integer >= 1
 *     unitPrice: string;     // decimal string
 *     taxRate: string;       // decimal string
 *     lineTotal: string;     // decimal string
 *   }>;
 *   payments: Array<{
 *     method: 'cash' | 'card' | 'mobile';
 *     amount: string;        // decimal string
 *   }>;
 *   userId: string;          // acting user (== cashierId)
 *   timestamp: string;       // ISO-8601 UTC
 * }
 * ```
 *
 * `PurchasePayload`:
 * ```ts
 * {
 *   purchaseId: string;
 *   supplierId: string;
 *   invoiceNo: string | null;
 *   total: string;           // decimal string
 *   items: Array<{
 *     productId: string;
 *     quantity: number;      // integer >= 1
 *     unitBuyPrice: string;  // decimal string
 *     lineTotal: string;     // decimal string
 *   }>;
 *   userId: string;
 *   timestamp: string;       // ISO-8601 UTC
 * }
 * ```
 *
 * `AdjustmentPayload`:
 * ```ts
 * {
 *   adjustmentId: string;    // deterministic correlation id (also on
 *                            // `InventoryMovement.referenceId`)
 *   productId: string;
 *   quantityDelta: number;   // signed integer (positive or negative)
 *   reason: string;
 *   userId: string;
 *   timestamp: string;       // ISO-8601 UTC
 * }
 * ```
 *
 * `PriceChangePayload`:
 * ```ts
 * {
 *   productId: string;
 *   previous: { buyPrice: string; sellPrice: string };
 *   next:     { buyPrice: string; sellPrice: string };
 *   userId: string;
 *   timestamp: string;       // ISO-8601 UTC
 * }
 * ```
 *
 * `RoleChangePayload` (task 12.2 owns the writer):
 * ```ts
 * {
 *   targetUserId: string;
 *   previousRole: 'admin' | 'cashier';
 *   newRole:      'admin' | 'cashier';
 *   userId: string;          // acting Admin
 *   timestamp: string;       // ISO-8601 UTC
 * }
 * ```
 *
 * The schema is intentionally flat per opType — recovery walks the
 * journal in order, dispatches on `opType`, and `upsert`s the
 * deterministic primary key carried in the payload, so a re-run of
 * the same entry is a no-op (design.md > "Recovery flow" > Property 5
 * + Property 12).
 *
 * Validates: Requirements 10.4, 10.5, 10.6.
 */

/** Operation type discriminator. */
export type JournalOpType =
  | 'sale'
  | 'purchase'
  | 'adjustment'
  | 'price.change'
  | 'role.change';

export interface JournalEntryDTO {
  readonly id: string;
  readonly opType: JournalOpType;
  /** Parsed from the persisted JSON string. */
  readonly payload: unknown;
  readonly timestamp: string;
}

export interface JournalFilter {
  readonly opType?: JournalOpType;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export type JournalSortKey = 'timestamp';
