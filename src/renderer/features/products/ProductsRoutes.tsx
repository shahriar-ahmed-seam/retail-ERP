/**
 * Router-aware wrappers for the products feature (task 13.1).
 *
 * The standalone `<ProductsListPage />` already owns the create / edit
 * sub-modes (it switches between table, form, and detail without
 * leaving the page). Wiring three separate routes (`/products`,
 * `/products/new`, `/products/:id/edit`) would double the surface and
 * needs a `products:get` IPC channel that V1 doesn't ship — the
 * existing standalone page is enough for the role-aware shell.
 *
 * The thin wrapper below exists for two reasons:
 *   1. Symmetry with the other feature wrappers in this directory.
 *   2. A single place to add router-bound enhancements later (e.g.
 *      open-in-edit-from-deep-link) without touching the standalone
 *      page.
 *
 * `/products/new` is exposed as a sibling route that simply renders
 * the list page — the list page's "New product" button does the
 * actual mode switch.
 */

import { type ReactElement } from 'react';

import { ProductsListPage } from './ProductsListPage';

export function ProductsListRoute(): ReactElement {
  return <ProductsListPage />;
}
