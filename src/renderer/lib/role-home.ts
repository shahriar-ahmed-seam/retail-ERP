/**
 * Role-aware home routing helper (task 13.1).
 *
 * The router uses a single `<Navigate to={roleHomeFor(role)} />` step
 * after authentication so the redirect lives in one place rather than
 * being open-coded at every entry point. Cashiers head straight to the
 * POS screen — that is their only daily surface (Req 14.3); Admins
 * land on the dashboard (placeholder until task 13.2 ships the real
 * one) which links out to the rest of the back-office surfaces.
 *
 * Validates: Requirements 1.5, 14.3.
 */

import type { SessionDTO } from '@shared/ipc-contract';

/**
 * Path to redirect to once the user is authenticated. Encoded as a
 * total function over the role union so adding a future role forces a
 * compile error at this call site.
 */
export function roleHomeFor(role: SessionDTO['role']): string {
  switch (role) {
    case 'Admin':
      return '/dashboard';
    case 'Cashier':
      return '/pos';
  }
}
