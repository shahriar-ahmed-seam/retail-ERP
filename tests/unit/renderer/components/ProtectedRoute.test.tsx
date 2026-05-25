/**
 * Unit tests for the route-level auth gate (task 13.1).
 *
 * Drives the gate by composing it inside a `<MemoryRouter>` with a
 * synthetic route tree. The auth context is bootstrapped via
 * `AuthProvider`'s `initialSession` so we never round-trip through
 * the IPC layer.
 *
 * Validates: Requirements 1.5, 14.3.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ProtectedRoute } from '@renderer/components/ProtectedRoute';
import { AuthProvider } from '@renderer/lib/auth-context';

import type { SessionDTO } from '@shared/ipc-contract';
import type { ReactElement } from 'react';

const adminSession: SessionDTO = {
  sessionId: 's-admin',
  userId: 'u-admin',
  username: 'owner',
  role: 'Admin',
};

function renderTree({
  initialSession,
  initialPath,
}: {
  initialSession: SessionDTO | null;
  initialPath: string;
}): ReactElement {
  return render(
    <AuthProvider initialSession={initialSession}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<div>login surface</div>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/secret" element={<div>secret surface</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  ) as unknown as ReactElement;
}

describe('<ProtectedRoute />', () => {
  it('renders the protected child when a session is present', () => {
    renderTree({ initialSession: adminSession, initialPath: '/secret' });
    expect(screen.getByText('secret surface')).toBeInTheDocument();
  });

  it('redirects to /login when no session is present', () => {
    renderTree({ initialSession: null, initialPath: '/secret' });
    expect(screen.getByText('login surface')).toBeInTheDocument();
    expect(screen.queryByText('secret surface')).toBeNull();
  });
});
