/**
 * Category DTOs.
 *
 * Categories are a small reference table — `Product.categoryId` is a
 * required FK so every product has exactly one category. The shape is
 * intentionally narrow: only `id` and `name` cross the IPC boundary
 * (Phase 4, task 4.1). Future fields (display order, color, parent
 * category) can be added without breaking the wire format because every
 * field declared here is required.
 *
 * Validates: Requirement 2.5.
 */

/** A category as returned by `categories:list` and `categories:upsert`. */
export interface CategoryDTO {
  readonly id: string;
  readonly name: string;
}

/**
 * Request payload for `categories:upsert`. Omit `id` to create; supply
 * `id` to update an existing record. `name` is required on both paths
 * and is trimmed + length-checked server-side (1..50 characters).
 */
export interface CategoryInput {
  readonly id?: string;
  readonly name: string;
}
