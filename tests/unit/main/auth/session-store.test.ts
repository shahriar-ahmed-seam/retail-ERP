import { afterEach, describe, expect, it } from 'vitest';

import {
  bind,
  clear,
  clearAll,
  get,
  sessionStore,
  type Session,
} from '@main/auth/session-store';

/**
 * Unit tests for the main-process session store (task 2.5).
 *
 * These cover the four-function surface that the IPC router middleware
 * relies on (design.md > "Process and IPC contract"):
 *   - `bind(senderId, session)`
 *   - `get(senderId)`
 *   - `clear(senderId)`
 *   - `clearAll()`
 *
 * Validates: Requirements 1.4, 1.5.
 */

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: overrides.userId ?? 'u-1',
    role: overrides.role ?? 'Admin',
    sessionId: overrides.sessionId ?? 's-1',
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}

// The store is module-state by design (one map per main process). Tests
// must reset it between cases so the order of execution does not matter.
afterEach(() => {
  clearAll();
});

describe('bind / get round-trip', () => {
  it('returns the session previously bound under the same senderId', () => {
    const session = makeSession({ userId: 'u-42', role: 'Cashier', sessionId: 's-42' });
    bind(7, session);
    expect(get(7)).toBe(session);
  });

  it('preserves every field of the Session shape (userId, role, sessionId, createdAt)', () => {
    const createdAt = new Date('2026-05-24T10:30:00Z');
    bind(
      11,
      makeSession({ userId: 'u-11', role: 'Cashier', sessionId: 's-11', createdAt }),
    );
    const found = get(11);
    expect(found).toEqual({
      userId: 'u-11',
      role: 'Cashier',
      sessionId: 's-11',
      createdAt,
    });
  });

  it('replaces the binding when the same senderId is re-bound', () => {
    bind(3, makeSession({ userId: 'u-old', sessionId: 's-old' }));
    bind(3, makeSession({ userId: 'u-new', sessionId: 's-new' }));
    const found = get(3);
    expect(found?.userId).toBe('u-new');
    expect(found?.sessionId).toBe('s-new');
  });

  it('keeps bindings for different senderIds independent', () => {
    const a = makeSession({ userId: 'u-a', sessionId: 's-a' });
    const b = makeSession({ userId: 'u-b', sessionId: 's-b' });
    bind(1, a);
    bind(2, b);
    expect(get(1)).toBe(a);
    expect(get(2)).toBe(b);
  });
});

describe('get for unknown senderId', () => {
  it('returns undefined when no binding exists', () => {
    expect(get(999)).toBeUndefined();
  });

  it('distinguishes a missing binding from a numerically nearby one', () => {
    bind(10, makeSession());
    expect(get(11)).toBeUndefined();
    expect(get(9)).toBeUndefined();
  });
});

describe('clear', () => {
  it('removes the binding for the given senderId', () => {
    bind(5, makeSession());
    clear(5);
    expect(get(5)).toBeUndefined();
  });

  it('leaves other bindings untouched', () => {
    const keep = makeSession({ userId: 'u-keep' });
    bind(5, makeSession({ userId: 'u-drop' }));
    bind(6, keep);
    clear(5);
    expect(get(5)).toBeUndefined();
    expect(get(6)).toBe(keep);
  });

  it('is a no-op for an unknown senderId', () => {
    bind(8, makeSession());
    expect(() => {
      clear(123456);
    }).not.toThrow();
    expect(get(8)).toBeDefined();
  });
});

describe('clearAll', () => {
  it('empties every binding', () => {
    bind(1, makeSession());
    bind(2, makeSession());
    bind(3, makeSession());
    clearAll();
    expect(get(1)).toBeUndefined();
    expect(get(2)).toBeUndefined();
    expect(get(3)).toBeUndefined();
  });

  it('is a no-op when the store is already empty', () => {
    expect(() => {
      clearAll();
    }).not.toThrow();
  });
});

describe('sessionStore namespace', () => {
  it('exposes the same four functions and shares state with the named exports', () => {
    const session = makeSession({ userId: 'u-ns', sessionId: 's-ns' });
    sessionStore.bind(20, session);
    expect(get(20)).toBe(session);
    expect(sessionStore.get(20)).toBe(session);
    sessionStore.clear(20);
    expect(get(20)).toBeUndefined();
  });

  it('is frozen so consumers cannot swap its methods at runtime', () => {
    expect(Object.isFrozen(sessionStore)).toBe(true);
  });
});
