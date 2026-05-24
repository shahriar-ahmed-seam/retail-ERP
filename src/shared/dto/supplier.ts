/**
 * Supplier DTOs.
 *
 * Validates: Requirements 6.1, 6.2, 6.3.
 */

export interface SupplierDTO {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly address: string | null;
}

export interface SupplierInput {
  readonly id?: string;
  readonly name: string;
  readonly phone?: string | null;
  readonly address?: string | null;
}

/** Reserved for future filters (status, region). The list channel sorts by name. */
export interface SupplierFilter {
  readonly _placeholder?: never;
}

export type SupplierSortKey = 'name';
