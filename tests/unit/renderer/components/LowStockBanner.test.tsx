/**
 * Unit tests for the persistent low-stock banner (task 10.9, Phase 10).
 *
 * Coverage:
 *   - Hidden when the count is 0.
 *   - Visible when the count is > 0.
 *   - Re-renders count changes from the polling loop.
 *   - Click invokes the `onNavigate` callback.
 *
 * Validates: Requirements 3.6, 9.3.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { LowStockBanner } from '@renderer/components/LowStockBanner';
import { Ok, Err } from '@shared/result';

import type { Api } from '@renderer/lib/api';

type GlobalWithWindow = typeof globalThis & {
  window: Window & { api?: Partial<Api> };
};
const g = globalThis as unknown as GlobalWithWindow;

function installApi(stub: Partial<Api>): void {
  g.window.api = stub;
}
function uninstallApi(): void {
  delete g.window.api;
}

afterEach(() => {
  uninstallApi();
  vi.useRealTimers();
});

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly lowStockCount: MockInstance;
}

function buildStub(values: readonly number[] | { error: true }): BuiltStub {
  let i = 0;
  const lowStockCount = vi.fn(() => {
    if ('error' in (values as Record<string, unknown>)) {
      return Promise.resolve(Err('UNAUTHENTICATED'));
    }
    const arr = values as readonly number[];
    const v = arr[Math.min(i, arr.length - 1)] ?? 0;
    i += 1;
    return Promise.resolve(Ok({ count: v }));
  });
  const stub: Partial<Api> = {
    'inventory:lowStockCount': lowStockCount,
  };
  return { stub, lowStockCount };
}

describe('<LowStockBanner />', () => {
  it('renders nothing when the count is 0', async () => {
    const built = buildStub([0]);
    installApi(built.stub);

    const { container } = render(<LowStockBanner pollIntervalMs={1_000_000} />);

    await waitFor(() => {
      expect(built.lowStockCount).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByTestId('low-stock-banner')).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it('renders the banner when the count is > 0', async () => {
    const built = buildStub([3]);
    installApi(built.stub);

    render(<LowStockBanner pollIntervalMs={1_000_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('low-stock-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('low-stock-banner')).toHaveAttribute(
      'data-low-stock-count',
      '3',
    );
    expect(screen.getByTestId('low-stock-banner-label')).toHaveTextContent(
      /3 products below reorder level/i,
    );
  });

  it('renders the singular form when the count is 1', async () => {
    const built = buildStub([1]);
    installApi(built.stub);

    render(<LowStockBanner pollIntervalMs={1_000_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('low-stock-banner-label')).toHaveTextContent(
        /1 product below reorder level/i,
      );
    });
  });

  it('invokes onNavigate when clicked', async () => {
    const built = buildStub([2]);
    installApi(built.stub);

    const onNavigate = vi.fn();
    const user = userEvent.setup();

    render(
      <LowStockBanner pollIntervalMs={1_000_000} onNavigate={onNavigate} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('low-stock-banner')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('low-stock-banner'));

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('keeps the banner hidden when the IPC call returns an error envelope', async () => {
    const built = buildStub({ error: true });
    installApi(built.stub);

    render(<LowStockBanner pollIntervalMs={1_000_000} />);

    await waitFor(() => {
      expect(built.lowStockCount).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('low-stock-banner')).not.toBeInTheDocument();
  });

  it('refreshes the count on the configured interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const built = buildStub([0, 4]);
    installApi(built.stub);

    render(<LowStockBanner pollIntervalMs={1_000} />);

    await vi.waitFor(() => {
      expect(built.lowStockCount).toHaveBeenCalledTimes(1);
    });

    // Advance past the interval — the second call should return count=4.
    await vi.advanceTimersByTimeAsync(1_500);

    await vi.waitFor(() => {
      expect(built.lowStockCount).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId('low-stock-banner-label')).toHaveTextContent(
        /4 products/i,
      );
    });
  });

  it('does not poll when disabled is true', async () => {
    const built = buildStub([5]);
    installApi(built.stub);

    render(<LowStockBanner disabled />);

    // Wait a tick to give any accidental polls a chance to fire.
    await new Promise((r) => {
      setTimeout(r, 10);
    });

    expect(built.lowStockCount).not.toHaveBeenCalled();
    expect(screen.queryByTestId('low-stock-banner')).not.toBeInTheDocument();
  });
});
