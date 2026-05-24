/**
 * Customer DTOs.
 *
 * Customers are optional on a sale (walk-in customers are persisted with
 * `customerId = null` per Req 7.4); the upsert and list channels mirror
 * the schema's `name` + optional `phone`. `phone` is `string | null`
 * end-to-end so renderers can clear an existing value by sending `null`
 * without colliding with `exactOptionalPropertyTypes`.
 *
 * Validates: Requirements 7.1, 7.3, 7.4.
 */

export interface CustomerDTO {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  /** ISO 8601 timestamp; persisted as `Customer.createdAt` (Req 16.4 sort). */
  readonly createdAt: string;
}

export interface CustomerInput {
  readonly id?: string;
  readonly name: string;
  readonly phone?: string | null;
}

export interface CustomerFilter {
  /** Prefix match against `Customer.phone` (Req 16.3, 16.4). */
  readonly phonePrefix?: string;
}

export type CustomerSortKey = 'name' | 'createdAt';
