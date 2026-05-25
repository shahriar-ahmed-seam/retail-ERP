/**
 * Unit tests for the role-aware route gate (task 13.1).
 *
 * Validates: Requirements 8.3, 14.3.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { RoleGate } from '@renderer/components/RoleGate';
import { AuthProvider } from '@renderer/lib/auth-context';

import type { SessionDTO } from '@shared/ipc-contract';

const adminSession: SessionDTO = {
  sessionId: 's-admin',
  userId: 'u-admin',
  username: 'owner',
  role: 'Admin',
};
const cashierSession: SessionDTO = {
  sessionId: 's-cashier',
  userId: 'u-cashier',
  username: 'till',
  role: 'Cashier',
};

function renderWith({
  session,
  initialPath,
}: {
  session: SessionDTO | null;
  initialPath: string;
}): void {
  render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<div>login surface</div>} />
          <Route path="/dashboard" element={<div>dashboard surface</div>} />
          <Route path="/pos" element={<div>pos surface</div>} />
          <Route
            path="/admin-only"
            element={
              <RoleGate allow={['Admin']}>
                <div>admin surface</div>
              </RoleGate>
            }
          />
          <Route
            path="/admin-only-forbidden"
            element={
              <RoleGate allow={['Admin']} onDeny="forbidden">
                <div>admin surface</div>
              </RoleGate>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('<RoleGate />', () => {
  it('renders the gated child when the session role is allowed', () => {
    renderWith({ session: adminSession, initialPath: '/admin-only' });
    expect(screen.getByText('admin surface')).toBeInTheDocument();
  });

  it("redirects to the role's home when the role is not allowed", () => {
    // Cashier hits Admin-only route → bounces to Cashier home (/pos).
    renderWith({ session: cashierSession, initialPath: '/admin-only' });
    expect(screen.getByText('pos surface')).toBeInTheDocument();
    expect(screen.queryByText('admin surface')).toBeNull();
  });

  it('renders the forbidden message when onDeny="forbidden"', () => {
    renderWith({
      session: cashierSession,
      initialPath: '/admin-only-forbidden',
    });
    expect(screen.getByTestId('role-gate-forbidden')).toBeInTheDocument();
    expect(screen.queryByText('admin surface')).toBeNull();
  });

  it('routes unauthenticated visitors back to /login defensively', () => {
    renderWith({ session: null, initialPath: '/admin-only' });
    expect(screen.getByText('login surface')).toBeInTheDocument();
  });
});
