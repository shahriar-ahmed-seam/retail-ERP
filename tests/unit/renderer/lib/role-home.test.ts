/**
 * Unit tests for the role-aware home routing helper (task 13.1).
 *
 * Validates: Requirements 1.5, 14.3.
 */

import { describe, expect, it } from 'vitest';

import { roleHomeFor } from '@renderer/lib/role-home';

describe('roleHomeFor', () => {
  it('routes Cashier sessions to /pos', () => {
    expect(roleHomeFor('Cashier')).toBe('/pos');
  });

  it('routes Admin sessions to /dashboard', () => {
    expect(roleHomeFor('Admin')).toBe('/dashboard');
  });
});
