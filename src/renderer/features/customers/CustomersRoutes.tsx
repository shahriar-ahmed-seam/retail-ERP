/**
 * Router-aware wrappers for the customers feature (task 13.1).
 *
 * The customers list page already owns its own mode-switching (list /
 * create / edit / detail) so the wrapper is a pass-through; the
 * dedicated detail / form routes exist so deep links land on a
 * stable URL without forcing the user to re-navigate from the list.
 *
 * Cashier reaches `/customers` and `/customers/:id` (read-only via
 * the Customers role gate); Admin reaches every wrapper.
 */

import { useCallback, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '@renderer/lib/auth-context';

import { CustomerDetailPage } from './CustomerDetailPage';
import { CustomerFormPage } from './CustomerFormPage';
import { CustomersListPage } from './CustomersListPage';

import type { CustomerDTO } from '@shared/dto/index';

export function CustomersListRoute(): ReactElement {
  return <CustomersListPage />;
}

export function CustomerCreateRoute(): ReactElement {
  const navigate = useNavigate();
  const onClose = useCallback((): void => {
    navigate('/customers');
  }, [navigate]);
  return <CustomerFormPage onClose={onClose} />;
}

export function CustomerDetailRoute(): ReactElement {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const isAdmin = session?.role === 'Admin';

  const onClose = useCallback((): void => {
    navigate('/customers');
  }, [navigate]);

  const onEdit = useCallback(
    (customer: CustomerDTO): void => {
      navigate(`/customers/${customer.id}/edit`);
    },
    [navigate],
  );

  if (params.id === undefined || params.id === '') {
    return <CustomersListPage />;
  }

  return (
    <CustomerDetailPage
      customerId={params.id}
      onClose={onClose}
      // Cashier sees the detail view as read-only; only Admin gets
      // the Edit button so the navigate-to-edit handler is wired.
      {...(isAdmin ? { onEdit } : {})}
    />
  );
}
