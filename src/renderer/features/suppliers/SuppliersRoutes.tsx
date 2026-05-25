/**
 * Router-aware wrappers for the suppliers feature (task 13.1).
 *
 * The standalone `<SuppliersListPage />` already owns its own
 * mode-switching (list / create / edit / detail) and that is the
 * surface the existing test suite exercises. The route wrapper is a
 * pass-through so we keep a single feature surface — the route tree
 * still calls out `/suppliers`, `/suppliers/new`, `/suppliers/:id`,
 * and `/suppliers/:id/edit` so deep links land somewhere sensible.
 *
 * Routes that need real per-id deep linking (`/suppliers/:id`) load
 * the `<SupplierDetailPage />` directly with the URL id; everything
 * else flows through the list page which kicks the user back to
 * `/suppliers` after a successful submit.
 */

import { useCallback, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { SupplierDetailPage } from './SupplierDetailPage';
import { SupplierFormPage } from './SupplierFormPage';
import { SuppliersListPage } from './SuppliersListPage';

import type { SupplierDTO } from '@shared/dto/index';

export function SuppliersListRoute(): ReactElement {
  return <SuppliersListPage />;
}

export function SupplierCreateRoute(): ReactElement {
  const navigate = useNavigate();
  const onClose = useCallback((): void => {
    navigate('/suppliers');
  }, [navigate]);
  return <SupplierFormPage onClose={onClose} />;
}

export function SupplierDetailRoute(): ReactElement {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();

  const onClose = useCallback((): void => {
    navigate('/suppliers');
  }, [navigate]);

  const onEdit = useCallback(
    (supplier: SupplierDTO): void => {
      navigate(`/suppliers/${supplier.id}/edit`);
    },
    [navigate],
  );

  if (params.id === undefined || params.id === '') {
    return <SuppliersListPage />;
  }

  return (
    <SupplierDetailPage
      supplierId={params.id}
      onClose={onClose}
      onEdit={onEdit}
    />
  );
}
