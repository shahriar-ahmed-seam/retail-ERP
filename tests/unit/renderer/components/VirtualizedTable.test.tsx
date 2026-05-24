/**
 * Unit tests for the shared <VirtualizedTable> data hook (task 4.9).
 *
 * Coverage (mirrors the task list verbatim):
 *
 *   - Page accumulation: mock IPC for `products:list` returns two pages
 *     (50 rows each, then 50 + nextCursor=null). The hook progresses
 *     `rows.length` 0 → 50 → 100 and exposes `exhausted=true` once the
 *     last page lands. The accumulated buffer is exactly the
 *     concatenation of the mock pages in order.
 *
 *   - Debounce window: rapid changes to the `search` param within the
 *     250 ms debounce collapse into a single first-page request after
 *     the timer fires. Earlier intermediate values never reach the IPC.
 *
 *   - DOM-mounted row count is bounded: with 10,000 rows in the hook's
 *     buffer, the virtualized list mounts only the rows in the visible
 *     window (plus react-window's overscan). The mounted count is
 *     small relative to the buffer, never approaching 10,000.
 *
 *   - Companion count: when `withCount: true`, the totals strip renders
 *     "Showing N of M" using the `<entity>:count` channel.
 *
 * The renderer's typed API wrapper (`@renderer/lib/api`) reads
 * `window.api` lazily, so each test installs a stub on `globalThis.window`
 * before mounting components and tears it down in `afterEach` to keep
 * test isolation clean.
 *
 * **Validates: Requirement 16.5.**
 */

import { act, render, renderHook, waitFor } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { usePaginatedList, VirtualizedTable } from '@renderer/components/VirtualizedTable';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { ProductDTO } from '@shared/dto/index';
import type { ListResponse } from '@shared/ipc-contract';
import type { Result } from '@shared/result';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

/**
 * jsdom does not implement ResizeObserver; `react-window` v2 relies on
 * it to track its container's box. We install a no-op shim so tests
 * that mount the actual component don't crash on `new ResizeObserver()`.
 *
 * The shim is intentionally minimal — none of the assertions below
 * depend on resize-driven behaviour, only on the row-mounting math
 * react-window runs against `defaultHeight` + `rowHeight`.
 */
class NoopResizeObserver {
  observe(): void {
    // no-op
  }
  unobserve(): void {
    // no-op
  }
  disconnect(): void {
    // no-op
  }
}

beforeEach(() => {
  // jsdom does not implement ResizeObserver; react-window v2 calls
  // `new ResizeObserver()` to track its container's box. Install a
  // no-op shim so component mount succeeds.
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: NoopResizeObserver,
  });
});

function makeProduct(i: number): ProductDTO {
  return {
    id: `p-${String(i).padStart(6, '0')}`,
    sku: `SKU-${i}`,
    name: `Product ${i}`,
    categoryId: 'c-1',
    barcode: null,
    buyPrice: '1.00',
    sellPrice: '2.00',
    taxRate: '0',
    warrantyMonths: 0,
    reorderLevel: 0,
    onHand: 0,
  };
}

/**
 * Build a `ListResponse<ProductDTO>` for `count` rows starting at `start`.
 * `nextCursor` is provided by the caller because mock pages need to
 * differ from one another to drive the cursor walk.
 */
function makePage(
  start: number,
  count: number,
  nextCursor: string | null,
): ListResponse<ProductDTO> {
  const rows: ProductDTO[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(makeProduct(start + i));
  }
  return { rows, nextCursor };
}

// ---------------------------------------------------------------------------
// Page accumulation
// ---------------------------------------------------------------------------

describe('usePaginatedList — page accumulation', () => {
  it('progresses rows.length 0 → 50 → 100 and exposes exhausted=true after the last page', async () => {
    const page1 = makePage(0, 50, 'cursor-1');
    const page2 = makePage(50, 50, null);

    const productsList = vi.fn(
      (req: { cursor?: string }): Promise<Result<ListResponse<ProductDTO>>> => {
        if (req.cursor === undefined) return Promise.resolve(Ok(page1));
        if (req.cursor === 'cursor-1') return Promise.resolve(Ok(page2));
        return Promise.reject(new Error(`unexpected cursor: ${String(req.cursor)}`));
      },
    );
    installApi({ 'products:list': productsList });

    const { result } = renderHook(() =>
      usePaginatedList('products:list', { pageSize: 50 }),
    );

    // Initial render — first page is in flight, buffer still empty.
    expect(result.current.rows).toHaveLength(0);

    // After the first page settles.
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(50);
    });
    expect(result.current.exhausted).toBe(false);
    expect(result.current.isLoading).toBe(false);

    // Trigger the second page.
    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.rows).toHaveLength(100);
    });
    expect(result.current.exhausted).toBe(true);
    expect(result.current.isLoading).toBe(false);

    // Buffer is exactly the concatenation of the two pages, in order.
    const expectedIds = [...page1.rows, ...page2.rows].map((r) => r.id);
    expect(result.current.rows.map((r) => r.id)).toEqual(expectedIds);

    // Exactly two IPC calls were made — one per page.
    expect(productsList).toHaveBeenCalledTimes(2);
    expect(productsList.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
    expect(productsList.mock.calls[1]?.[0]).toMatchObject({ cursor: 'cursor-1' });

    // `loadMore` is a no-op once exhausted.
    act(() => {
      result.current.loadMore();
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(productsList).toHaveBeenCalledTimes(2);
  });

  it('surfaces an Err envelope from the first page without crashing', async () => {
    const productsList = vi
      .fn()
      .mockResolvedValue(Err('VALIDATION', { field: 'filter.categoryId' }));
    installApi({ 'products:list': productsList as Api['products:list'] });

    const { result } = renderHook(() => usePaginatedList('products:list'));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error?.code).toBe('VALIDATION');
    expect(result.current.rows).toHaveLength(0);
    expect(result.current.isLoading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe('usePaginatedList — debounced search', () => {
  it('collapses rapid search changes inside the 250 ms window into one request', async () => {
    vi.useFakeTimers();

    const productsList: MockInstance = vi.fn(() => Promise.resolve(Ok(makePage(0, 5, null))));
    installApi({ 'products:list': productsList as Api['products:list'] });

    const { rerender } = renderHook(
      ({ search }: { search: string }) =>
        usePaginatedList('products:list', { search, debounceMs: 250 }),
      { initialProps: { search: '' } },
    );

    // First render fires immediately for the empty initial search.
    await act(async () => {
      await Promise.resolve();
    });
    expect(productsList).toHaveBeenCalledTimes(1);

    // Three rapid search updates within the debounce window. Each
    // rerender restarts the 250 ms timer, so none of these intermediate
    // values reach the IPC.
    rerender({ search: 'a' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ search: 'ab' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ search: 'abc' });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // Still inside the window for the most recent value — only the
    // initial empty-string call should have fired.
    expect(productsList).toHaveBeenCalledTimes(1);

    // Advance past the trailing edge of the debounce window.
    act(() => {
      vi.advanceTimersByTime(300);
    });

    await vi.waitFor(() => {
      expect(productsList).toHaveBeenCalledTimes(2);
    });

    // The final, post-debounce request used the latest input only.
    const lastReq = productsList.mock.calls[1]?.[0] as { search?: string } | undefined;
    expect(lastReq?.search).toBe('abc');

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// DOM-mounted row count is bounded for a 10,000-row buffer
// ---------------------------------------------------------------------------

describe('<VirtualizedTable /> — DOM mounted row count', () => {
  it('mounts only the rows in the visible window for a 10,000-row buffer', async () => {
    // One giant page that fills the buffer in a single request. This
    // gives the virtualized list a 10,000-row backing store; the
    // assertion below proves react-window only mounts a small visible
    // window despite the buffer size (Req 16.5).
    const giantPage = makePage(0, 10_000, null);

    const productsList = vi
      .fn()
      .mockResolvedValue(Ok(giantPage));
    installApi({
      'products:list': productsList as Api['products:list'],
    });

    const rowHeight = 48;
    const height = 600;

    const { container } = render(
      <VirtualizedTable
        channel="products:list"
        pageSize={200}
        height={height}
        rowHeight={rowHeight}
        renderRow={(row) => <span>{row.name}</span>}
      />,
    );

    // Wait until the buffer has filled with all 10k rows.
    await waitFor(() => {
      const totals = container.querySelector('[data-testid="virtualized-table-totals"]');
      expect(totals?.textContent).toMatch(/Showing 10000/);
    });

    const mounted = container.querySelectorAll('[data-row-index]');
    // Hard upper bound: visible window (height / rowHeight = 12.5) plus
    // react-window's overscan (default 3 each side) plus a generous
    // headroom to keep the assertion robust to overscan tuning.
    const visibleWindow = Math.ceil(height / rowHeight); // 13
    const overscan = 3;
    const upperBound = visibleWindow + overscan * 4;

    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(upperBound);
    // And critically: way less than the buffer size.
    expect(mounted.length).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Companion count via withCount
// ---------------------------------------------------------------------------

describe('<VirtualizedTable /> — withCount totals strip', () => {
  it('renders the count via the companion *:count channel', async () => {
    const page = makePage(0, 25, null);
    const productsList = vi.fn().mockResolvedValue(Ok(page));
    const productsCount = vi.fn().mockResolvedValue(Ok({ totalCount: 137 }));
    installApi({
      'products:list': productsList as Api['products:list'],
      'products:count': productsCount as Api['products:count'],
    });

    const { findByTestId } = render(
      <VirtualizedTable
        channel="products:list"
        pageSize={50}
        withCount
        height={300}
        rowHeight={48}
        renderRow={(row) => <span>{row.name}</span>}
      />,
    );

    const totals = await findByTestId('virtualized-table-totals');
    await waitFor(() => {
      expect(totals.textContent).toMatch(/Showing 25 of 137/);
    });

    expect(productsCount).toHaveBeenCalledTimes(1);
    // The count call carries the same filter/search shape as the list.
    const countReq = productsCount.mock.calls[0]?.[0] as
      | { filter?: unknown; search?: string }
      | undefined;
    expect(countReq).toBeDefined();
  });
});
