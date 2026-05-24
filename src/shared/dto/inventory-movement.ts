/**
 * Inventory ledger DTOs.
 *
 * The inventory ledger is the source of truth for stock; every
 * stock-changing operation appends exactly one `InventoryMovement` row
 * inside the same `$transaction` as its parent business event (design.md >
 * "Atomicity Strategy", Property 1). This DTO is what `inventory:adjust`
 * returns and what `inventory_movements:list` paginates over.
 *
 * `quantityDelta` is a signed integer: positive for purchases and returns,
 * negative for sales, signed (in either direction) for manual adjustments.
 *
 * Validates: Requirements 3.1, 3.2, 3.5, 11.4.
 */

/** Movement type discriminator. Kept as a union of string literals so the
 *  renderer can render specific badges per type without a join. */
export type MovementType = 'sale' | 'purchase' | 'adjustment' | 'return';

/** Reference type discriminator. */
export type ReferenceType = 'sale' | 'purchase' | 'adjustment';

export interface InventoryMovementDTO {
  readonly id: string;
  readonly productId: string;
  /** Joined display name; main pulls this in the same query as the row. */
  readonly productName: string;
  /** Signed integer delta (Req 3.1). */
  readonly quantityDelta: number;
  readonly movementType: MovementType;
  readonly referenceType: ReferenceType;
  readonly referenceId: string;
  readonly userId: string;
  /** Joined display name for the actor that committed the movement. */
  readonly userName: string;
  /** ISO 8601 timestamp; cursor sort column (Req 16.4). */
  readonly timestamp: string;
}

/** Request payload for `inventory:adjust`. */
export interface AdjustmentInput {
  readonly productId: string;
  /** Signed integer delta; main rejects if it would make on-hand negative
   *  (Property 3 / Req 3.7). */
  readonly quantityDelta: number;
  /** Free-form reason text persisted to the audit log (Req 13.3). */
  readonly reason: string;
}

export interface MovementFilter {
  readonly productId?: string;
  readonly movementType?: MovementType;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export type MovementSortKey = 'timestamp';
