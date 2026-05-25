/**
 * Router-aware wrappers for the inventory feature (task 13.1).
 *
 * The two inventory surfaces are siblings rather than a hierarchy:
 *   - `/inventory/adjust`     → manual stock adjustment form
 *   - `/inventory/movements`  → admin-only ledger browser
 *
 * The adjust page already renders an inline success indicator, so the
 * route wrapper is a pass-through (no auto-navigate; the user picks
 * the next adjustment). The movements browser exposes an `onNavigate`
 * callback that fires when a row is clicked — for the v1 router we
 * route reference clicks to feature-specific surfaces where they
 * exist (sales: `/sales/:id` does not yet exist; purchase rows route
 * to `/purchases`; adjustments route to the audit log).
 */

import { useCallback, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { AdjustPage } from './AdjustPage';
import {
  MovementsBrowserPage,
  type MovementNavigationTarget,
} from './MovementsBrowserPage';

export function AdjustRoute(): ReactElement {
  return <AdjustPage />;
}

export function MovementsBrowserRoute(): ReactElement {
  const navigate = useNavigate();

  // Map a reference-type click to the closest existing surface.
  // Today none of the per-id detail routes for sales / purchases
  // ship in V1 (no `/sales/:id` page yet), so we route at the
  // feature level and leave a trail for future deep-linking.
  const onNavigate = useCallback(
    (target: MovementNavigationTarget): void => {
      switch (target.referenceType) {
        case 'sale':
          // No sales-detail page in V1 — closest surface is the POS
          // home (every sale finalizes through POS). Future task can
          // route to `/sales/${target.referenceId}`.
          navigate('/pos');
          return;
        case 'purchase':
          navigate('/purchases');
          return;
        case 'adjustment':
          navigate('/audit');
          return;
      }
    },
    [navigate],
  );

  return <MovementsBrowserPage onNavigate={onNavigate} />;
}
