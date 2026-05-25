/**
 * Route tree for the role-aware shell (task 13.1).
 *
 * Layered as three concentric gates:
 *
 *   1. `/setup` — only matched while the main process reports
 *      `setup:isRequired === true`. The branch is gated outside the
 *      router (in `<App />`) so we never paint the app shell on a
 *      fresh installation.
 *
 *   2. `/login` — public entry point. Already-authenticated sessions
 *      get redirected to their role home so a refresh on `/login`
 *      doesn't kick the user back to a sign-in form they don't need.
 *
 *   3. Authenticated subtree wrapped in `<ProtectedRoute>` and the
 *      `<Shell>` layout. The home `/` redirects to the role-specific
 *      landing (`/dashboard` for Admin, `/pos` for Cashier). Each
 *      Admin-only feature is wrapped in `<RoleGate allow={['Admin']}>`;
 *      shared surfaces (POS, customers, low-stock report) accept both
 *      roles.
 *
 * Per-feature routes are kept thin — the actual page components live
 * in `src/renderer/features/<feature>/` and their `*Routes.tsx`
 * wrappers translate the URL into navigation callbacks the standalone
 * pages already accept.
 *
 * Validates: Requirements 1.5, 8.3, 14.3.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';

import { ProtectedRoute } from '@renderer/components/ProtectedRoute';
import { RoleGate } from '@renderer/components/RoleGate';
import { Shell } from '@renderer/components/Shell';
import { BackupPage } from '@renderer/features/backup';
import {
  CustomerFormPage,
} from '@renderer/features/customers';
import {
  CustomerCreateRoute,
  CustomerDetailRoute,
  CustomersListRoute,
} from '@renderer/features/customers/CustomersRoutes';
import { DashboardPage } from '@renderer/features/dashboard';
import {
  AdjustRoute,
  MovementsBrowserRoute,
} from '@renderer/features/inventory/InventoryRoutes';
import { LoginPage } from '@renderer/features/login';
import { POSPage } from '@renderer/features/pos';
import { ProductsListRoute } from '@renderer/features/products/ProductsRoutes';
import {
  PurchaseCreateRoute,
  PurchasesListRoute,
} from '@renderer/features/purchases/PurchasesRoutes';
import {
  DailySalesPage,
  LowStockReportPage,
  MonthlySalesPage,
  TopSellingReportPage,
} from '@renderer/features/reports';
import { PrinterSettingsPage } from '@renderer/features/settings';
import {
  SupplierFormPage,
} from '@renderer/features/suppliers';
import {
  SupplierCreateRoute,
  SupplierDetailRoute,
  SuppliersListRoute,
} from '@renderer/features/suppliers/SuppliersRoutes';
import { AuditLogPage } from '@renderer/features/users/AuditLogPage';
import { useApi } from '@renderer/lib/api';
import { useAuth } from '@renderer/lib/auth-context';
import { roleHomeFor } from '@renderer/lib/role-home';

import type { CustomerDTO, SupplierDTO } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Edit-form route wrappers (kept inline so they capture URL params + the
// navigation hook without a third file).
// ---------------------------------------------------------------------------

function CustomerEditRoute(): ReactElement {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const api = useApi();

  const [customer, setCustomer] = useState<CustomerDTO | null>(null);
  const [error, setError] = useState<ErrorEnvelope | null>(null);

  useEffect(() => {
    if (params.id === undefined || params.id === '') return undefined;
    let cancelled = false;
    void (async () => {
      const result = await api['customers:detail']({
        id: params.id ?? '',
        history: { pageSize: 1, withCount: false },
      });
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCustomer(result.value.customer);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, params.id]);

  const onClose = useCallback(
    (saved?: CustomerDTO): void => {
      if (saved !== undefined) {
        navigate(`/customers/${saved.id}`);
        return;
      }
      navigate('/customers');
    },
    [navigate],
  );

  const goBack = useCallback((): void => {
    navigate('/customers');
  }, [navigate]);

  if (params.id === undefined || params.id === '') {
    return <Navigate to="/customers" replace />;
  }

  if (error !== null) {
    return (
      <main
        role="alert"
        data-testid="customer-edit-route-error"
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          maxWidth: '32rem',
          margin: '4rem auto',
          textAlign: 'center',
          color: '#555',
        }}
      >
        <h1 style={{ marginBottom: '0.5rem' }}>Cannot open customer</h1>
        <p>
          {error.code}: {error.message}
        </p>
        <button
          type="button"
          onClick={goBack}
          style={{ padding: '0.375rem 0.75rem', marginTop: '1rem' }}
        >
          Back to customers
        </button>
      </main>
    );
  }

  if (customer === null) {
    return (
      <main
        data-testid="customer-edit-route-loading"
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          textAlign: 'center',
          color: '#555',
        }}
      >
        Loading customer…
      </main>
    );
  }

  return <CustomerFormPage customer={customer} onClose={onClose} />;
}

function SupplierEditRoute(): ReactElement {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const api = useApi();

  const [supplier, setSupplier] = useState<SupplierDTO | null>(null);
  const [error, setError] = useState<ErrorEnvelope | null>(null);

  useEffect(() => {
    if (params.id === undefined || params.id === '') return undefined;
    let cancelled = false;
    void (async () => {
      const result = await api['suppliers:detail']({
        id: params.id ?? '',
        history: { pageSize: 1, withCount: false },
      });
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSupplier(result.value.supplier);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, params.id]);

  const onClose = useCallback(
    (saved?: SupplierDTO): void => {
      if (saved !== undefined) {
        navigate(`/suppliers/${saved.id}`);
        return;
      }
      navigate('/suppliers');
    },
    [navigate],
  );

  const goBack = useCallback((): void => {
    navigate('/suppliers');
  }, [navigate]);

  if (params.id === undefined || params.id === '') {
    return <Navigate to="/suppliers" replace />;
  }

  if (error !== null) {
    return (
      <main
        role="alert"
        data-testid="supplier-edit-route-error"
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          maxWidth: '32rem',
          margin: '4rem auto',
          textAlign: 'center',
          color: '#555',
        }}
      >
        <h1 style={{ marginBottom: '0.5rem' }}>Cannot open supplier</h1>
        <p>
          {error.code}: {error.message}
        </p>
        <button
          type="button"
          onClick={goBack}
          style={{ padding: '0.375rem 0.75rem', marginTop: '1rem' }}
        >
          Back to suppliers
        </button>
      </main>
    );
  }

  if (supplier === null) {
    return (
      <main
        data-testid="supplier-edit-route-loading"
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          textAlign: 'center',
          color: '#555',
        }}
      >
        Loading supplier…
      </main>
    );
  }

  return <SupplierFormPage supplier={supplier} onClose={onClose} />;
}

// ---------------------------------------------------------------------------
// Public + redirector routes
// ---------------------------------------------------------------------------

/**
 * `/login` route component. Redirects already-authenticated sessions
 * to their role home so a refresh on `/login` does the right thing.
 */
function LoginRoute(): ReactElement {
  const { session } = useAuth();
  const location = useLocation();
  if (session !== null) {
    // `state.from` is set by `<ProtectedRoute>` when it bounced an
    // unauthenticated request to `/login`; honour it on the next pass
    // so the user lands where they intended. Fall back to the role
    // home otherwise.
    const fromState = location.state as { readonly from?: string } | null;
    const from =
      fromState !== null && typeof fromState.from === 'string'
        ? fromState.from
        : null;
    return <Navigate to={from ?? roleHomeFor(session.role)} replace />;
  }
  return <LoginPage />;
}

/**
 * `/` redirector. Sends the user to the role's home — Cashier → POS,
 * Admin → dashboard.
 */
function HomeRoute(): ReactElement {
  const { session } = useAuth();
  if (session === null) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to={roleHomeFor(session.role)} replace />;
}

/**
 * Catch-all 404 fallback. Authenticated users land on the role home;
 * unauthenticated users get bounced to `/login`.
 */
function NotFoundRoute(): ReactElement {
  const { session } = useAuth();
  if (session === null) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to={roleHomeFor(session.role)} replace />;
}

// ---------------------------------------------------------------------------
// Public route tree
// ---------------------------------------------------------------------------

export function AppRoutes(): ReactElement {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginRoute />} />

      {/* Authenticated subtree — Shell + role gates */}
      <Route element={<ProtectedRoute />}>
        <Route element={<Shell />}>
          <Route index element={<HomeRoute />} />

          {/* Admin-only home */}
          <Route
            path="dashboard"
            element={
              <RoleGate allow={['Admin']}>
                <DashboardPage />
              </RoleGate>
            }
          />

          {/* POS — Admin and Cashier */}
          <Route path="pos" element={<POSPage />} />

          {/* Products — Admin only (Cashier read-only deferred to a future task) */}
          <Route element={<RoleGate allow={['Admin']} />}>
            <Route path="products" element={<ProductsListRoute />} />
            <Route path="products/new" element={<ProductsListRoute />} />
            <Route
              path="products/:id/edit"
              element={<ProductsListRoute />}
            />
          </Route>

          {/* Inventory — Admin only */}
          <Route element={<RoleGate allow={['Admin']} />}>
            <Route path="inventory/adjust" element={<AdjustRoute />} />
            <Route
              path="inventory/movements"
              element={<MovementsBrowserRoute />}
            />
          </Route>

          {/* Suppliers — Admin only */}
          <Route element={<RoleGate allow={['Admin']} />}>
            <Route path="suppliers" element={<SuppliersListRoute />} />
            <Route path="suppliers/new" element={<SupplierCreateRoute />} />
            <Route path="suppliers/:id" element={<SupplierDetailRoute />} />
            <Route path="suppliers/:id/edit" element={<SupplierEditRoute />} />
          </Route>

          {/* Customers — Admin (write) + Cashier (read) */}
          <Route path="customers" element={<CustomersListRoute />} />
          <Route path="customers/:id" element={<CustomerDetailRoute />} />
          {/* Admin-only writes */}
          <Route element={<RoleGate allow={['Admin']} />}>
            <Route path="customers/new" element={<CustomerCreateRoute />} />
            <Route
              path="customers/:id/edit"
              element={<CustomerEditRoute />}
            />
          </Route>

          {/* Purchases — Admin only */}
          <Route element={<RoleGate allow={['Admin']} />}>
            <Route path="purchases" element={<PurchasesListRoute />} />
            <Route path="purchases/new" element={<PurchaseCreateRoute />} />
          </Route>

          {/* Reports — Admin (most) + Cashier (low-stock visibility) */}
          <Route element={<RoleGate allow={['Admin']} />}>
            <Route path="reports/daily" element={<DailySalesPage />} />
            <Route path="reports/monthly" element={<MonthlySalesPage />} />
            <Route
              path="reports/top-selling"
              element={<TopSellingReportPage />}
            />
          </Route>
          {/* Low-stock report visible to both roles. */}
          <Route
            path="reports/low-stock"
            element={<LowStockReportPage />}
          />

          {/* Backup — Admin */}
          <Route element={<RoleGate allow={['Admin']} />}>
            <Route path="backup" element={<BackupPage />} />
          </Route>

          {/* Audit log — Admin */}
          <Route element={<RoleGate allow={['Admin']} />}>
            <Route path="audit" element={<AuditLogPage />} />
          </Route>

          {/* Settings — Admin */}
          <Route element={<RoleGate allow={['Admin']} />}>
            <Route
              path="settings/printer"
              element={<PrinterSettingsPage />}
            />
          </Route>

          {/* Catch-all inside the shell — bounce to role home */}
          <Route path="*" element={<NotFoundRoute />} />
        </Route>
      </Route>

      {/* Catch-all outside the shell. Reachable only when the user
          hits a path that isn't covered above and the auth gate hasn't
          rendered. We fall through to the same redirector. */}
      <Route path="*" element={<NotFoundRoute />} />
    </Routes>
  );
}
