import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  api,
  resetToastHandler,
  setToastHandler,
  shouldToast,
  withToasts,
  type Api,
  type ToastHandler,
} from '@renderer/lib/api';
import { Err, Ok } from '@shared/result';

/**
 * Unit tests for the renderer's typed IPC wrapper (task 2.7).
 *
 * Covers:
 *   - `api` proxy delegates each `api.<channel>(req)` call to
 *     `window.api[channel](req)`.
 *   - `api` proxy resolves with an `INTERNAL` Result envelope when the
 *     preload bridge is missing, instead of throwing synchronously.
 *   - `withToasts` invokes the active toast handler exactly for
 *     `INTERNAL` and `UNAUTHENTICATED` envelopes (Req 1.5 surface).
 *   - `withToasts` is a pure pass-through for successful results and for
 *     non-toastable error envelopes (e.g. `VALIDATION`, `FORBIDDEN`).
 *   - `shouldToast` matches the wrapper's classification.
 *
 * The unit project runs under the `node` environment, so `window` is not
 * defined by default. Each test that exercises the proxy installs a mock
 * `window.api` on `globalThis` and tears it down afterward.
 *
 * Validates: Requirements 1.5.
 */

type GlobalWithWindow = typeof globalThis & {
  window?: { api?: Partial<Api> };
};

const g = globalThis as GlobalWithWindow;

function installWindowApi(stub: Partial<Api>): void {
  g.window = { api: stub };
}

function clearWindow(): void {
  delete g.window;
}

afterEach(() => {
  clearWindow();
  resetToastHandler();
  vi.restoreAllMocks();
});

describe('api proxy', () => {
  it('delegates a channel call to window.api with the request payload', async () => {
    const finalize = vi.fn().mockResolvedValue(
      Ok({ saleId: 's-1', serialNo: 'INV-000001', sale: { id: 's-1' } as never }),
    );
    installWindowApi({ 'pos:finalize': finalize as Api['pos:finalize'] });

    const req = {
      items: [],
      payments: [],
      discount: { kind: 'fixed', amount: '0' },
    } as unknown as Parameters<Api['pos:finalize']>[0];

    const result = await api['pos:finalize'](req);

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(req);
    expect(result.ok).toBe(true);
  });

  it('forwards void-request channels with no argument', async () => {
    const logout = vi.fn().mockResolvedValue(Ok(undefined));
    installWindowApi({ 'auth:logout': logout as Api['auth:logout'] });

    const result = await api['auth:logout']();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('returns an INTERNAL Result when window.api is missing', async () => {
    clearWindow();
    const result = await api['auth:logout']();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.message).toMatch(/window/i);
    }
  });

  it('returns an INTERNAL Result for an unknown channel', async () => {
    installWindowApi({});
    const unknownChannel = api as unknown as Record<string, () => Promise<unknown>>;
    const result = (await unknownChannel['definitely:not-a-channel']!()) as ReturnType<
      Api['auth:logout']
    > extends Promise<infer R>
      ? R
      : never;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.message).toMatch(/unknown ipc channel/i);
    }
  });

  it('preserves the rejected Result when the underlying handler returns Err', async () => {
    const login = vi
      .fn()
      .mockResolvedValue(Err('UNAUTHENTICATED', { reason: 'bad-credentials' }));
    installWindowApi({ 'auth:login': login as Api['auth:login'] });

    const result = await api['auth:login']({ username: 'a', password: 'b' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
      expect(result.error.details).toEqual({ reason: 'bad-credentials' });
    }
  });
});

describe('withToasts', () => {
  function makeStubApi(handler: Api['auth:login']): Api {
    installWindowApi({ 'auth:login': handler });
    return api;
  }

  it('invokes the toast handler for INTERNAL envelopes', async () => {
    const toast = vi.fn<ToastHandler>();
    setToastHandler(toast);

    const stub = vi
      .fn()
      .mockResolvedValue(Err('INTERNAL', undefined, { errorId: 'eid-1' }));
    const wrapped = withToasts(makeStubApi(stub as Api['auth:login']));

    const result = await wrapped['auth:login']({ username: 'a', password: 'b' });

    expect(result.ok).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INTERNAL', errorId: 'eid-1' }),
    );
  });

  it('invokes the toast handler for UNAUTHENTICATED envelopes', async () => {
    const toast = vi.fn<ToastHandler>();
    setToastHandler(toast);

    const stub = vi.fn().mockResolvedValue(Err('UNAUTHENTICATED'));
    const wrapped = withToasts(makeStubApi(stub as Api['auth:login']));

    await wrapped['auth:login']({ username: 'a', password: 'b' });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0].code).toBe('UNAUTHENTICATED');
  });

  it('does not toast for non-toastable error codes (VALIDATION, FORBIDDEN, ...)', async () => {
    const toast = vi.fn<ToastHandler>();
    setToastHandler(toast);

    const stub = vi.fn().mockResolvedValue(Err('VALIDATION', { field: 'username' }));
    const wrapped = withToasts(makeStubApi(stub as Api['auth:login']));

    await wrapped['auth:login']({ username: '', password: 'b' });

    expect(toast).not.toHaveBeenCalled();
  });

  it('does not toast for successful results', async () => {
    const toast = vi.fn<ToastHandler>();
    setToastHandler(toast);

    const stub = vi.fn().mockResolvedValue(
      Ok({ sessionId: 's', userId: 'u', username: 'a', role: 'Admin' as const }),
    );
    const wrapped = withToasts(makeStubApi(stub as Api['auth:login']));

    const result = await wrapped['auth:login']({ username: 'a', password: 'b' });

    expect(result.ok).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('returns the underlying Result unchanged regardless of toast firing', async () => {
    const toast = vi.fn<ToastHandler>();
    setToastHandler(toast);

    const errResult = Err('INTERNAL');
    const stub = vi.fn().mockResolvedValue(errResult);
    const wrapped = withToasts(makeStubApi(stub as Api['auth:login']));

    const result = await wrapped['auth:login']({ username: 'a', password: 'b' });

    expect(result).toEqual(errResult);
  });

  it('isolates a misbehaving toast handler from the IPC contract', async () => {
    setToastHandler(() => {
      throw new Error('boom');
    });

    const stub = vi.fn().mockResolvedValue(Err('INTERNAL'));
    const wrapped = withToasts(makeStubApi(stub as Api['auth:login']));

    // Must not throw.
    const result = await wrapped['auth:login']({ username: 'a', password: 'b' });

    expect(result.ok).toBe(false);
  });
});

describe('shouldToast', () => {
  it('returns true for INTERNAL and UNAUTHENTICATED', () => {
    expect(shouldToast('INTERNAL')).toBe(true);
    expect(shouldToast('UNAUTHENTICATED')).toBe(true);
  });

  it.each([
    'VALIDATION',
    'OUT_OF_STOCK',
    'UNIQUE_VIOLATION',
    'FK_VIOLATION',
    'FORBIDDEN',
    'PRINTER_FAILURE',
    'DB_INTEGRITY',
  ] as const)('returns false for non-toastable code %s', (code) => {
    expect(shouldToast(code)).toBe(false);
  });
});

describe('default toast handler', () => {
  it('logs the envelope without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const stub = vi.fn().mockResolvedValue(Err('INTERNAL', undefined, { errorId: 'eid-2' }));
    installWindowApi({ 'auth:login': stub as Api['auth:login'] });
    const wrapped = withToasts(api);

    await wrapped['auth:login']({ username: 'a', password: 'b' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('INTERNAL');
  });
});

describe('setToastHandler / resetToastHandler', () => {
  let toast: ReturnType<typeof vi.fn<ToastHandler>>;

  beforeEach(() => {
    toast = vi.fn<ToastHandler>();
  });

  it('routes errors to the installed handler', async () => {
    setToastHandler(toast);

    const stub = vi.fn().mockResolvedValue(Err('UNAUTHENTICATED'));
    installWindowApi({ 'auth:login': stub as Api['auth:login'] });
    const wrapped = withToasts(api);

    await wrapped['auth:login']({ username: 'a', password: 'b' });

    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default handler after reset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setToastHandler(toast);
    resetToastHandler();

    const stub = vi.fn().mockResolvedValue(Err('UNAUTHENTICATED'));
    installWindowApi({ 'auth:login': stub as Api['auth:login'] });
    const wrapped = withToasts(api);

    await wrapped['auth:login']({ username: 'a', password: 'b' });

    expect(toast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
