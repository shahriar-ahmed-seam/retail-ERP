/**
 * Audit log DTO.
 *
 * `AuditLog` is append-only (Req 13.4); no service ever updates or deletes
 * rows. The `previous` and `next` columns are persisted as JSON strings;
 * the DTO surface parses them into `unknown` so the renderer can render a
 * generic before/after diff without a per-action-type switch in the
 * service. UIs that want strongly-typed shapes type-narrow on
 * `actionType`.
 *
 * Validates: Requirements 8.4, 13.1, 13.2, 13.3, 13.4.
 */

/** Action type discriminator. New action types are added as they're wired
 *  in their owning phases (e.g. `role.change` in Phase 12). */
export type AuditActionType =
  | 'price.change'
  | 'role.change'
  | 'stock.adjust'
  | 'rbac.deny'
  | 'user.create'
  | 'user.update'
  | 'settings.update'
  | 'backup.restore';

export interface AuditLogDTO {
  readonly id: string;
  readonly actionType: AuditActionType;
  readonly entityType: string;
  readonly entityId: string;
  /** Parsed from the persisted JSON string; absent if the action has no
   *  meaningful "before" state (e.g. `user.create`). */
  readonly previous: unknown;
  /** Parsed from the persisted JSON string; absent for delete-style
   *  actions or pure observations like `rbac.deny`. */
  readonly next: unknown;
  /** Acting user, `null` only for system-originated entries. */
  readonly userId: string | null;
  readonly userName: string | null;
  readonly timestamp: string;
}

export interface AuditFilter {
  readonly actionType?: AuditActionType;
  readonly userId?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export type AuditSortKey = 'timestamp';
