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
