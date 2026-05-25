/**
 * Router-aware wrappers for the purchases feature (task 13.1).
 *
 * The standalone create page renders a success banner after submit
 * (task 6.3) but does not navigate by itself. The route wrapper
 * passes an `onCreated` callback so a successful purchase entry
 * routes back to the list (`/purchases`).
 */

import { useCallback, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { PurchaseCreatePage } from './PurchaseCreatePage';
import { PurchasesListPage } from './PurchasesListPage';

export function PurchasesListRoute(): ReactElement {
  return <PurchasesListPage />;
}

export function PurchaseCreateRoute(): ReactElement {
  const navigate = useNavigate();
  const onCreated = useCallback((): void => {
    navigate('/purchases');
  }, [navigate]);

  return <PurchaseCreatePage onCreated={onCreated} />;
}
