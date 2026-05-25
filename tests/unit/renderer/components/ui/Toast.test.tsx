/**
 * Unit tests for the Toast system (task 13.4).
 *
 * Coverage:
 *   - `errorEnvelopeToToast` maps every `ErrorCode` to a friendly
 *     `{variant, title, description?}` payload.
 *   - `<ToastProvider>` exposes `showToast` / `dismissToast` via the
 *     `useToast()` hook.
 *   - Toasts render in the portal viewport with the right
 *     `role` (alert vs status) per variant.
 *   - Manual dismiss removes the toast.
 *   - Auto-dismiss removes the toast after the configured duration.
 *   - `durationMs: 0` disables auto-dismiss.
 *   - Calling `useToast()` outside the provider throws.
 *
 * Validates: Requirements 1.2, 3.7, 4.8, 4.9, 5.5.
 */

import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import {
  errorEnvelopeToToast,
  ToastProvider,
  useToast,
  type ToastContextValue,
} from '@renderer/components/ui';

import type { ErrorEnvelope } from '@shared/result';

afterEach(() => {
  vi.useRealTimers();
});

describe('errorEnvelopeToToast', () => {
  it('maps INTERNAL with errorId into the description', () => {
    const env: ErrorEnvelope = {
      code: 'INTERNAL',
      message: 'Boom',
      errorId: 'eid-7',
    };
    const opts = errorEnvelopeToToast(env);
    expect(opts.variant).toBe('error');
    expect(opts.title).toMatch(/something went wrong/i);
    expect(opts.description).toMatch(/Boom/);
    expect(opts.description).toMatch(/eid-7/);
  });

  it('maps OUT_OF_STOCK to the warning variant', () => {
    const env: ErrorEnvelope = {
      code: 'OUT_OF_STOCK',
      message: 'Item is empty',
    };
    const opts = errorEnvelopeToToast(env);
    expect(opts.variant).toBe('warning');
    expect(opts.title).toMatch(/out of stock/i);
  });

  it('maps UNAUTHENTICATED to a sign-in prompt error', () => {
    const env: ErrorEnvelope = {
      code: 'UNAUTHENTICATED',
      message: 'no session',
    };
    const opts = errorEnvelopeToToast(env);
    expect(opts.variant).toBe('error');
    expect(opts.title).toMatch(/session expired/i);
  });

  it.each([
    ['VALIDATION', 'error'],
    ['UNIQUE_VIOLATION', 'error'],
    ['FK_VIOLATION', 'error'],
    ['FORBIDDEN', 'error'],
    ['DB_INTEGRITY', 'error'],
    ['PRINTER_FAILURE', 'warning'],
    ['USER_CANCELED', 'info'],
  ] as const)('maps %s to %s', (code, variant) => {
    const env: ErrorEnvelope = { code, message: 'msg' };
    const opts = errorEnvelopeToToast(env);
    expect(opts.variant).toBe(variant);
  });

  it('produces a stable shape for every code (returns title + description)', () => {
    const codes: ErrorEnvelope['code'][] = [
      'VALIDATION',
      'OUT_OF_STOCK',
      'UNIQUE_VIOLATION',
      'FK_VIOLATION',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'USER_CANCELED',
      'PRINTER_FAILURE',
      'DB_INTEGRITY',
      'INTERNAL',
    ];
    for (const code of codes) {
      const env: ErrorEnvelope = { code, message: 'm' };
      const opts = errorEnvelopeToToast(env);
      expect(typeof opts.title).toBe('string');
      expect(opts.title.length).toBeGreaterThan(0);
      expect(typeof opts.description).toBe('string');
    }
  });
});

describe('useToast() outside a provider', () => {
  let consoleError: MockInstance;
  beforeEach(() => {
    // renderHook surfaces the throw via React's error boundary path,
    // and React 18 logs to console.error too — silence it.
    consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    consoleError.mockRestore();
  });
  it('throws a clear message', () => {
    expect(() => renderHook(() => useToast())).toThrow(/ToastProvider/);
  });
});

describe('<ToastProvider>', () => {
  it('renders a toast added via showToast', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const { result } = renderHook(() => useToast(), { wrapper });

    let id = '';
    act(() => {
      id = result.current.showToast({
        variant: 'success',
        title: 'Saved',
        description: 'OK',
      });
    });

    expect(id).toMatch(/^toast-/);
    expect(screen.getByTestId('toast-viewport')).toBeInTheDocument();
    expect(screen.getByTestId(`toast-${id}-title`)).toHaveTextContent('Saved');
    expect(
      screen.getByTestId(`toast-${id}-description`),
    ).toHaveTextContent('OK');
  });

  it('uses role="alert" for error variants and role="status" otherwise', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const { result } = renderHook(() => useToast(), { wrapper });

    let errorId = '';
    let infoId = '';
    act(() => {
      errorId = result.current.showToast({
        variant: 'error',
        title: 'boom',
      });
      infoId = result.current.showToast({ variant: 'info', title: 'meh' });
    });

    expect(screen.getByTestId(`toast-${errorId}`)).toHaveAttribute(
      'role',
      'alert',
    );
    expect(screen.getByTestId(`toast-${infoId}`)).toHaveAttribute(
      'role',
      'status',
    );
  });

  it('removes a toast when its dismiss button is clicked', async () => {
    let api: ToastContextValue | null = null;
    function Capture(): null {
      api = useToast();
      return null;
    }
    render(
      <ToastProvider>
        <Capture />
      </ToastProvider>,
    );
    let id = '';
    act(() => {
      id = api!.showToast({
        variant: 'success',
        title: 'hi',
      });
    });
    expect(screen.getByTestId(`toast-${id}`)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId(`toast-${id}-dismiss`));

    expect(screen.queryByTestId(`toast-${id}`)).not.toBeInTheDocument();
  });

  it('auto-dismisses after the configured duration', () => {
    vi.useFakeTimers();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider defaultDurationMs={1000}>{children}</ToastProvider>
    );
    const { result } = renderHook(() => useToast(), { wrapper });

    let id = '';
    act(() => {
      id = result.current.showToast({ variant: 'success', title: 'gone' });
    });
    expect(screen.getByTestId(`toast-${id}`)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(screen.queryByTestId(`toast-${id}`)).not.toBeInTheDocument();
  });

  it('does not auto-dismiss when durationMs is 0', () => {
    vi.useFakeTimers();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider defaultDurationMs={500}>{children}</ToastProvider>
    );
    const { result } = renderHook(() => useToast(), { wrapper });

    let id = '';
    act(() => {
      id = result.current.showToast({
        variant: 'error',
        title: 'sticky',
        durationMs: 0,
      });
    });

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(screen.getByTestId(`toast-${id}`)).toBeInTheDocument();
  });

  it('manually dismissing via dismissToast removes the toast', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const { result } = renderHook(() => useToast(), { wrapper });

    let id = '';
    act(() => {
      id = result.current.showToast({
        variant: 'info',
        title: 'manual',
      });
    });
    expect(screen.getByTestId(`toast-${id}`)).toBeInTheDocument();

    act(() => {
      result.current.dismissToast(id);
    });

    expect(screen.queryByTestId(`toast-${id}`)).not.toBeInTheDocument();
  });

  it('a caller-supplied id replaces the previous toast with the same id', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.showToast({
        id: 'fixed',
        variant: 'success',
        title: 'first',
      });
      result.current.showToast({
        id: 'fixed',
        variant: 'error',
        title: 'second',
      });
    });

    // Only the second copy remains.
    const toasts = screen.getAllByTestId(/^toast-fixed$/);
    expect(toasts).toHaveLength(1);
    expect(screen.getByTestId('toast-fixed-title')).toHaveTextContent(
      'second',
    );
  });
});
