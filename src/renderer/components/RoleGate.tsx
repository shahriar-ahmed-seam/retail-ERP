/**
 * Role-aware route gate (task 13.1).
 *
 * Wraps a single route or subtree that is restricted to a non-empty
 * subset of session roles. When the active session's role is not in
 * the allowed set the gate either redirects to the role's home (the
 * default — keeps the user on a surface they can use) or renders an
 * inline "Permission denied" panel.
 *
 * `<RoleGate>` is purposely **separate** from `<ProtectedRoute>` so
 * the route tree can compose them: an authenticated subtree may have
 * some routes available to both roles (POS, customers) and others
 * locked to Admin (products, suppliers, settings).
 *
 * Validates: Requirements 1.5, 8.3, 14.3.
 */

import { type ReactElement } from 'react';
import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '@renderer/lib/auth-context';
import { roleHomeFor } from '@renderer/lib/role-home';

import type { SessionDTO } from '@shared/ipc-contract';

type Role = SessionDTO['role'];

export interface RoleGateProps {
  /** Roles allowed to view the gated subtree. */
  readonly allow: readonly Role[];
  /**
   * Behaviour when the current role is not in `allow`. `'redirect'`
   * (default) sends the user to their role's home; `'forbidden'`
   * renders an inline message — useful for nested routes where a
   * navigation flicker would be jarring.
   */
  readonly onDeny?: 'redirect' | 'forbidden';
  /**
   * Child element to render when the gate passes. When omitted the
   * router's `<Outlet />` is rendered — the default usage when
   * `RoleGate` is mounted as the parent of a route subtree.
   */
  readonly children?: ReactElement;
}

export function RoleGate({
  allow,
  onDeny = 'redirect',
  children,
}: RoleGateProps): ReactElement {
  const { session } = useAuth();

  // The auth gate (`<ProtectedRoute>`) is supposed to run first, so a
  // missing session here is a programmer error. We still handle it
  // defensively by routing to login — never crash a user out of a
  // role-gated page just because the parent gate was forgotten.
  if (session === null) {
    return <Navigate to="/login" replace />;
  }

  if (!allow.includes(session.role)) {
    if (onDeny === 'forbidden') {
      return <ForbiddenMessage role={session.role} />;
    }
    return <Navigate to={roleHomeFor(session.role)} replace />;
  }

  if (children !== undefined) {
    return children;
  }

  return <Outlet />;
}

function ForbiddenMessage({ role }: { readonly role: Role }): ReactElement {
  return (
    <main
      role="alert"
      data-testid="role-gate-forbidden"
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        maxWidth: '32rem',
        margin: '4rem auto',
        textAlign: 'center',
        color: '#555',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>Permission denied</h1>
      <p>
        Your role ({role}) does not have access to this surface. Please
        return to the home screen or sign in as a user with the required
        role.
      </p>
    </main>
  );
}
