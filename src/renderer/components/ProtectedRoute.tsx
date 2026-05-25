/**
 * Authentication gate for the route tree (task 13.1).
 *
 * Wraps every authenticated route. If the renderer has no session it
 * redirects to `/login`; if the renderer is mid-`setup` (no admin
 * exists yet) it redirects to `/setup`. The component renders the
 * outlet for any authenticated descendant once the gate passes.
 *
 * The setup probe is owned by `<App />` so this component can stay
 * synchronous — it reads the cached `setupRequired` flag from the
 * surrounding `<RouterContextProvider>` (also defined alongside the
 * router) rather than re-issuing the IPC call on every navigation.
 *
 * Validates: Requirements 1.5, 14.3.
 */

import { type ReactElement } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '@renderer/lib/auth-context';

export interface ProtectedRouteProps {
  /**
   * Child element to render when the gate passes. When omitted the
   * router's `<Outlet />` is rendered — that is the default usage when
   * `ProtectedRoute` is mounted as the parent of a route subtree.
   */
  readonly children?: ReactElement;
}

export function ProtectedRoute({
  children,
}: ProtectedRouteProps): ReactElement {
  const { session } = useAuth();
  const location = useLocation();

  if (session === null) {
    // Preserve the originally-requested location so a future
    // login-redirect-back enhancement can resume the flow. We never
    // chain back automatically in V1 because the role-home redirect
    // takes precedence — see `roleHomeFor` in `lib/role-home.ts`.
    return (
      <Navigate to="/login" replace state={{ from: location.pathname }} />
    );
  }

  if (children !== undefined) {
    return children;
  }

  return <Outlet />;
}
