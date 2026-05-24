import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the categories IPC handler group (Phase 4, task 4.1).
 *
 * Drives each channel through `invokeHandlerForTest` — the same code
 * path Electron's `ipcMain.handle` uses in production — so the
 * assertions cover the full middleware chain (auth + RBAC + audit +
 * handler), not just the handler bodies.
 *
 * Critically, this means we exercise the static RBAC matrix end-to-end:
 *   - admin sessions can call all three channels,
 *   - cashier sessions can call `categories:list` but are denied on
 *     `categories:upsert` and `categories:delete` with `FORBIDDEN`,
 *   - the denial path emits an `rbac.deny` audit row (Req 8.4).
 *
 * `@main/services/category.service` is mocked so the service surface is
 * deterministic and the audit-row count is not polluted by domain-level
 * Prisma writes.
 *
 * Validates: Requirements 2.5, 8.4.
 */

// ---------------------------------------------------------------------------
// CategoryService mock
// ---------------------------------------------------------------------------

const categoryMock = vi.hoisted(() => ({
  list: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@main/services/category.service', () => ({
  CategoryService: categoryMock,
}));

vi.mock('@main/services/category.service.js', () => ({
  CategoryService: categoryMock,
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerCategoriesHandlers } from '@main/ipc/handlers/categories';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { CategoryDTO } from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Recording audit writer
// ---------------------------------------------------------------------------

class RecordingAuditWriter implements AuditWriter {
  public readonly rows: AuditWriteInput[] = [];
  public write(input: AuditWriteInput): Promise<void> {
    this.rows.push(input);
    return Promise.resolve();
  }
}

let recorder: RecordingAuditWriter;
const ADMIN_SENDER = 100;
const CASHIER_SENDER = 200;

function bindAdmin(): void {
  sessionStore.bind(ADMIN_SENDER, {
    userId: 'u-admin',
    role: 'Admin',
    sessionId: 's-admin',
    createdAt: new Date(),
  });
}

function bindCashier(): void {
  sessionStore.bind(CASHIER_SENDER, {
    userId: 'u-cashier',
    role: 'Cashier',
    sessionId: 's-cashier',
    createdAt: new Date(),
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  categoryMock.list.mockReset();
  categoryMock.upsert.mockReset();
  categoryMock.delete.mockReset();

  registerCategoriesHandlers();
});

afterEach(() => {
  resetAuditWriter();
  clearHandlers();
  sessionStore.clearAll();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

describe('registerCategoriesHandlers', () => {
  it('registers all three channels: list, upsert, delete', () => {
    expect(hasHandler('categories:list')).toBe(true);
    expect(hasHandler('categories:upsert')).toBe(true);
    expect(hasHandler('categories:delete')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerCategoriesHandlers();
    }).not.toThrow();
    expect(hasHandler('categories:list')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate (default `requiresAuth: true`)
// ---------------------------------------------------------------------------

describe('categories:* require an authenticated session', () => {
  it('categories:list returns UNAUTHENTICATED with no session', async () => {
    const result = await invokeHandlerForTest('categories:list', ADMIN_SENDER, undefined as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(categoryMock.list).not.toHaveBeenCalled();
  });

  it('categories:upsert returns UNAUTHENTICATED with no session', async () => {
    const result = await invokeHandlerForTest('categories:upsert', ADMIN_SENDER, {
      name: 'Hardware',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(categoryMock.upsert).not.toHaveBeenCalled();
  });

  it('categories:delete returns UNAUTHENTICATED with no session', async () => {
    const result = await invokeHandlerForTest('categories:delete', ADMIN_SENDER, {
      id: 'cat-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(categoryMock.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// categories:list — Admin and Cashier both allowed (Req 2.5, 8.3)
// ---------------------------------------------------------------------------

describe('categories:list handler', () => {
  it('Admin can call it and receives the rows envelope', async () => {
    const rows: readonly CategoryDTO[] = [
      { id: 'cat-1', name: 'Hardware' },
      { id: 'cat-2', name: 'Lighting' },
    ];
    categoryMock.list.mockResolvedValue(Ok({ rows }));
    bindAdmin();

    const result = await invokeHandlerForTest('categories:list', ADMIN_SENDER, undefined as never);

    expect(categoryMock.list).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual(rows);
    }
  });

  it('Cashier can also call it (cashiers see categories for product display)', async () => {
    categoryMock.list.mockResolvedValue(Ok({ rows: [] }));
    bindCashier();

    const result = await invokeHandlerForTest(
      'categories:list',
      CASHIER_SENDER,
      undefined as never,
    );

    expect(result.ok).toBe(true);
    expect(categoryMock.list).toHaveBeenCalledTimes(1);
    // No RBAC denial audit rows.
    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// categories:upsert — Admin only (Req 2.5)
// ---------------------------------------------------------------------------

describe('categories:upsert handler', () => {
  it('Admin can call it and receives the upserted DTO', async () => {
    const dto: CategoryDTO = { id: 'cat-new', name: 'Hardware' };
    categoryMock.upsert.mockResolvedValue(Ok(dto));
    bindAdmin();

    const result = await invokeHandlerForTest('categories:upsert', ADMIN_SENDER, {
      name: 'Hardware',
    });

    expect(categoryMock.upsert).toHaveBeenCalledWith({ name: 'Hardware' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(dto);
    }
  });

  it('forwards the request payload (id + name) untouched to the service', async () => {
    categoryMock.upsert.mockResolvedValue(Ok({ id: 'cat-1', name: 'Power Tools' }));
    bindAdmin();

    await invokeHandlerForTest('categories:upsert', ADMIN_SENDER, {
      id: 'cat-1',
      name: 'Power Tools',
    });

    expect(categoryMock.upsert).toHaveBeenCalledWith({ id: 'cat-1', name: 'Power Tools' });
  });

  it('forwards UNIQUE_VIOLATION envelopes from the service unchanged', async () => {
    categoryMock.upsert.mockResolvedValue(Err('UNIQUE_VIOLATION', { field: 'name' }));
    bindAdmin();

    const result = await invokeHandlerForTest('categories:upsert', ADMIN_SENDER, {
      name: 'Hardware',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNIQUE_VIOLATION');
      expect(result.error.details).toEqual({ field: 'name' });
    }
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('categories:upsert', CASHIER_SENDER, {
      name: 'Hardware',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'categories:upsert' });
    }
    expect(categoryMock.upsert).not.toHaveBeenCalled();

    const denyRow = recorder.rows.find((r) => r.actionType === 'rbac.deny');
    expect(denyRow).toBeDefined();
    expect(denyRow?.entityId).toBe('categories:upsert');
    expect(denyRow?.userId).toBe('u-cashier');
  });
});

// ---------------------------------------------------------------------------
// categories:delete — Admin only (Req 2.5)
// ---------------------------------------------------------------------------

describe('categories:delete handler', () => {
  it('Admin can call it and receives Ok(undefined) on success', async () => {
    categoryMock.delete.mockResolvedValue(Ok(undefined));
    bindAdmin();

    const result = await invokeHandlerForTest('categories:delete', ADMIN_SENDER, {
      id: 'cat-1',
    });

    expect(categoryMock.delete).toHaveBeenCalledWith('cat-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  it('forwards FK_VIOLATION { reason: "category_in_use" } envelopes unchanged', async () => {
    categoryMock.delete.mockResolvedValue(
      Err('FK_VIOLATION', { reason: 'category_in_use', productCount: 3 }),
    );
    bindAdmin();

    const result = await invokeHandlerForTest('categories:delete', ADMIN_SENDER, {
      id: 'cat-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toMatchObject({ reason: 'category_in_use' });
    }
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('categories:delete', CASHIER_SENDER, {
      id: 'cat-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'categories:delete' });
    }
    expect(categoryMock.delete).not.toHaveBeenCalled();

    const denyRow = recorder.rows.find((r) => r.actionType === 'rbac.deny');
    expect(denyRow).toBeDefined();
    expect(denyRow?.entityId).toBe('categories:delete');
  });
});
