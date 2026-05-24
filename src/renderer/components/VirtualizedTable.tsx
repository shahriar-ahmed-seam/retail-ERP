/**
 * Shared virtualized table + paginated-list data hook (task 4.8).
 *
 * Two pieces ship from this module:
 *
 *   1. {@link usePaginatedList} — a typed React hook that drives any
 *      `*:list` IPC channel under the shared `ListRequest`/`ListResponse`
 *      envelope (design.md > "List channel pagination contract"). The hook
 *      owns cursor state, page accumulation, filter/sort change resets,
 *      a 250 ms search debounce, in-flight cancellation across params
 *      changes, and an optional companion `*:count` lookup for totals.
 *
 *   2. {@link VirtualizedTable} — a thin wrapper around `react-window`'s
 *      `List` that mounts only the rows currently in the visible window
 *      (Req 16.5) and triggers `loadMore()` as the user scrolls toward
 *      the end of the accumulated buffer.
 *
 * The component is the single reuse target for products, customers,
 * suppliers, sales, purchases, inventory_movements, audit, journal, and
 * any reports preview that can exceed 200 rows. Channel typing is done
 * statically — the `C extends PaginatedListChannel` bound is the union
 * of every `IpcContract` key whose response is `ListResponse<T>`, so a
 * call like `usePaginatedList('users:list', ...)` (which is *not*
 * paginated) fails to typecheck.
 *
 * Validates: Requirements 16.1, 16.2, 16.3, 16.5.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { List, type RowComponentProps } from 'react-window';

import { useApi } from '@renderer/lib/api';

import type {
  IpcContract,
  IpcRequest,
  IpcResponse,
  ListRequest,
  ListResponse,
} from '@shared/ipc-contract';
import type { ErrorEnvelope, Result } from '@shared/result';

// ---------------------------------------------------------------------------
// Channel-type constraints
// ---------------------------------------------------------------------------

/**
 * Union of every `IpcContract` channel whose response is a `ListResponse<T>`.
 *
 * The conditional walks `keyof IpcContract` and keeps only those keys
 * whose `IpcResponse` matches the `ListResponse<unknown>` envelope —
 * which by construction is exactly the eight `*:list` channels declared
 * in the contract. Channels like `users:list` (returns `{ rows: ... }`
 * outside the envelope) and `customers:detail` (returns an object that
 * *contains* a `ListResponse` rather than being one) are correctly
 * excluded.
 */
export type PaginatedListChannel = {
  [K in keyof IpcContract]: IpcResponse<K> extends ListResponse<unknown> ? K : never;
}[keyof IpcContract];

/** Row type accumulated by `usePaginatedList(channel)`. */
export type ListRowOf<C extends PaginatedListChannel> =
  IpcResponse<C> extends ListResponse<infer T> ? T : never;

/** Per-channel filter shape declared by the channel's `ListRequest<F, S>`. */
export type ListFilterOf<C extends PaginatedListChannel> =
  IpcRequest<C> extends ListRequest<infer F, string> ? F : never;

/** Per-channel sort-key union declared by the channel's `ListRequest<F, S>`. */
export type ListSortOf<C extends PaginatedListChannel> =
  IpcRequest<C> extends ListRequest<unknown, infer S>
    ? S extends string
      ? S
      : never
    : never;

/**
 * Map a paginated list channel name to its companion count channel name.
 *
 * Naming convention from `IpcContract`: every `<entity>:list` channel
 * has an `<entity>:count` companion declared right next to it. Template-
 * literal types extract the prefix and re-form the count name; the
 * conditional `extends keyof IpcContract` rules out any future list
 * channel that ships without a count companion (the type narrows to
 * `never` and the call below fails to compile, surfacing the omission).
 */
export type CountChannelFor<C extends PaginatedListChannel> =
  C extends `${infer Prefix}:list`
    ? `${Prefix}:count` extends keyof IpcContract
      ? `${Prefix}:count`
      : never
    : never;

// ---------------------------------------------------------------------------
// Hook params and result
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by {@link usePaginatedList}. All callers pass
 * channel-shaped `filter` and `sort` values; the hook itself is opaque
 * to their content and forwards them unchanged into the IPC request.
 */
export interface UsePaginatedListParams<C extends PaginatedListChannel> {
  /** Server-side filter forwarded into the channel's `ListRequest.filter`. */
  readonly filter?: ListFilterOf<C>;
  /** Search string; debounced before forwarding (default 250 ms). */
  readonly search?: string;
  /** Sort spec forwarded into the channel's `ListRequest.sort`. */
  readonly sort?: { readonly key: ListSortOf<C>; readonly dir: 'asc' | 'desc' };
  /** Page size; clamped server-side to `[1, 200]` regardless of input. */
  readonly pageSize?: number;
  /**
   * When true, the hook also fetches `<entity>:count` on every filter
   * change and exposes the result on `totalCount`. When false (default)
   * the page response's optional `totalCount` is used, which is
   * typically omitted from list responses.
   */
  readonly withCount?: boolean;
  /** Override the search debounce window (ms). Default 250. */
  readonly debounceMs?: number;
  /** Disable the hook entirely; useful for conditional gating in pages. */
  readonly enabled?: boolean;
}

/** Public return shape of {@link usePaginatedList}. */
export interface UsePaginatedListResult<C extends PaginatedListChannel> {
  /** Accumulated rows across every page fetched since the last reset. */
  readonly rows: readonly ListRowOf<C>[];
  /** True while a page (or count) request is in flight. */
  readonly isLoading: boolean;
  /** Most recent `Err` envelope from a list/count call, if any. */
  readonly error: ErrorEnvelope | null;
  /** True when the last response had `nextCursor === null`. */
  readonly exhausted: boolean;
  /** Total row count when `withCount` is opted in, otherwise undefined. */
  readonly totalCount: number | undefined;
  /** Trigger the next page (no-op when loading, exhausted, or no cursor). */
  readonly loadMore: () => void;
  /** Drop accumulated rows and refetch the first page. */
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

interface InternalState<TRow> {
  rows: readonly TRow[];
  /** Cursor for the *next* page; null on first load and after exhaustion. */
  cursor: string | null;
  exhausted: boolean;
  isLoading: boolean;
  error: ErrorEnvelope | null;
  totalCount: number | undefined;
}

function makeInitialState<TRow>(): InternalState<TRow> {
  return {
    rows: [],
    cursor: null,
    exhausted: false,
    isLoading: false,
    error: null,
    totalCount: undefined,
  };
}

// ---------------------------------------------------------------------------
// usePaginatedList
// ---------------------------------------------------------------------------

/**
 * Drive a `*:list` IPC channel with cursor pagination, debounced search,
 * and append-on-scroll page accumulation. Designed as the single data
 * source for {@link VirtualizedTable} but exported standalone for any
 * non-table consumer (typeahead suggestions, batch pickers, …).
 *
 * State machine summary:
 *   - On mount: fetch first page with the initial params.
 *   - On filter / search (post-debounce) / sort / pageSize / withCount
 *     change: bump an internal epoch (cancelling any in-flight request),
 *     reset the row buffer, and refetch from page one.
 *   - On `loadMore()`: append the next page using the stored cursor;
 *     no-op if a request is already in flight, the result is exhausted,
 *     or there is no cursor.
 *   - On unmount: bump the epoch so any pending response is dropped
 *     instead of calling `setState` on a torn-down component.
 *
 * Cancellation is implemented with a monotonic epoch counter rather
 * than `AbortController`: the renderer-side `api` proxy does not expose
 * an abort signal, and dropping stale responses on resolve is sufficient
 * to keep `rows` consistent with the most recent params. The earlier
 * request still resolves on the main process — that work is wasted but
 * not incorrect.
 */
export function usePaginatedList<C extends PaginatedListChannel>(
  channel: C,
  params: UsePaginatedListParams<C> = {},
): UsePaginatedListResult<C> {
  const api = useApi();

  const {
    filter,
    search = '',
    sort,
    pageSize,
    withCount = false,
    debounceMs = 250,
    enabled = true,
  } = params;

  // -------------------------------------------------------------------------
  // Search debounce
  // -------------------------------------------------------------------------
  // Mirror `search` into a debounced state value; the data effect below
  // depends only on the debounced value so a flurry of keystrokes inside
  // the debounce window collapses into a single request.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    if (search === debouncedSearch) return undefined;
    const handle = setTimeout(() => {
      setDebouncedSearch(search);
    }, debounceMs);
    return () => {
      clearTimeout(handle);
    };
  }, [search, debouncedSearch, debounceMs]);

  // -------------------------------------------------------------------------
  // Stable params key for reset detection
  // -------------------------------------------------------------------------
  // Filter / sort are objects re-created by every parent render. We
  // build a content-based key (JSON string) so the data effect only
  // resets when the content actually changes — not on identity churn.
  const filterKey = useMemo(() => safeStringify(filter), [filter]);
  const sortKey = useMemo(() => safeStringify(sort), [sort]);
  const paramsKey = `${channel}|${filterKey}|${debouncedSearch}|${sortKey}|${
    pageSize ?? ''
  }|${String(withCount)}`;

  // -------------------------------------------------------------------------
  // State + refs
  // -------------------------------------------------------------------------
  type Row = ListRowOf<C>;
  const [state, setState] = useState<InternalState<Row>>(() => makeInitialState<Row>());

  // Mirror state in a ref so async callbacks can read it synchronously
  // without re-creating themselves on every state update.
  const stateRef = useRef<InternalState<Row>>(state);
  stateRef.current = state;

  // Latest params snapshot, also pulled from a ref by `fetchPage`.
  const latestRef = useRef({
    channel,
    filter,
    search: debouncedSearch,
    sort,
    pageSize,
    withCount,
  });
  latestRef.current = {
    channel,
    filter,
    search: debouncedSearch,
    sort,
    pageSize,
    withCount,
  };

  // Epoch counter. Each `fetchPage` call captures the current value;
  // any later `fetchPage` (filter change, unmount) bumps it, and the
  // captured closure drops its result if epochRef.current diverged.
  const epochRef = useRef(0);
  useEffect(() => {
    return () => {
      // Bump on unmount so any in-flight resolve is dropped silently.
      epochRef.current += 1;
    };
  }, []);

  // -------------------------------------------------------------------------
  // fetchPage — the single async path used by both reset + loadMore
  // -------------------------------------------------------------------------
  const fetchPage = useCallback(
    async (cursor: string | null, isReset: boolean): Promise<void> => {
      epochRef.current += 1;
      const myEpoch = epochRef.current;

      const snapshot = latestRef.current;

      // Reset clears rows + cursor + error in one go; non-reset flips
      // isLoading + clears the previous error so the spinner is right.
      if (isReset) {
        setState({
          ...makeInitialState<Row>(),
          isLoading: true,
        });
      } else {
        setState((prev) => ({ ...prev, isLoading: true, error: null }));
      }

      // Build the typed `ListRequest`. Optional fields are added
      // conditionally so an absent `cursor` / `search` does not collide
      // with `exactOptionalPropertyTypes`.
      const req = buildListRequest({
        filter: snapshot.filter,
        search: snapshot.search,
        sort: snapshot.sort,
        cursor,
        pageSize: snapshot.pageSize,
      });

      // Dynamic dispatch through the typed `api` proxy. The constraint
      // `C extends PaginatedListChannel` guarantees the response is a
      // `ListResponse<Row>`; cast accordingly at the boundary.
      const callList = (api as Record<string, unknown>)[snapshot.channel] as (
        request: IpcRequest<C>,
      ) => Promise<Result<IpcResponse<C>>>;

      let listResult: Result<IpcResponse<C>>;
      try {
        listResult = await callList(req as IpcRequest<C>);
      } catch (e) {
        if (epochRef.current !== myEpoch) return;
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: {
            code: 'INTERNAL',
            message: e instanceof Error ? e.message : 'List request threw',
          },
        }));
        return;
      }

      if (epochRef.current !== myEpoch) return;

      if (!listResult.ok) {
        const failure = listResult.error;
        setState((prev) => ({ ...prev, isLoading: false, error: failure }));
        return;
      }

      const page = listResult.value as ListResponse<Row>;

      setState((prev) => ({
        ...prev,
        isLoading: false,
        rows: isReset ? [...page.rows] : [...prev.rows, ...page.rows],
        cursor: page.nextCursor,
        exhausted: page.nextCursor === null,
        // Inline totalCount from the page response is honoured iff present.
        totalCount: page.totalCount ?? prev.totalCount,
      }));

      // Optional companion count lookup — fired alongside the first
      // page only, since the count is filter-stable across pagination.
      if (isReset && snapshot.withCount) {
        await fetchCount({
          api,
          channel: snapshot.channel,
          filter: snapshot.filter,
          search: snapshot.search,
          myEpoch,
          epochRef,
          setState,
        });
      }
    },
    [api],
  );

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------
  // Reset + first-page fetch on params change. `fetchPage` is stable
  // (only depends on `api`); `paramsKey` is the content-based trigger.
  useEffect(() => {
    if (!enabled) return;
    void fetchPage(null, true);
  }, [enabled, paramsKey, fetchPage]);

  // -------------------------------------------------------------------------
  // Public callbacks
  // -------------------------------------------------------------------------
  const loadMore = useCallback((): void => {
    const current = stateRef.current;
    if (current.isLoading || current.exhausted || current.cursor === null) return;
    void fetchPage(current.cursor, false);
  }, [fetchPage]);

  const reset = useCallback((): void => {
    void fetchPage(null, true);
  }, [fetchPage]);

  return {
    rows: state.rows,
    isLoading: state.isLoading,
    error: state.error,
    exhausted: state.exhausted,
    totalCount: state.totalCount,
    loadMore,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a `ListRequest` from the hook's snapshot, omitting any field
 * that is unset so the request shape matches `exactOptionalPropertyTypes`
 * (no explicit `undefined` keys reach the IPC bridge).
 */
function buildListRequest(input: {
  filter: unknown;
  search: string;
  sort: { key: string; dir: 'asc' | 'desc' } | undefined;
  cursor: string | null;
  pageSize: number | undefined;
}): ListRequest<unknown, string> {
  const req: ListRequest<unknown, string> = {};
  if (input.filter !== undefined) req.filter = input.filter;
  if (input.search !== '') req.search = input.search;
  if (input.sort !== undefined) req.sort = input.sort;
  if (input.cursor !== null) req.cursor = input.cursor;
  if (input.pageSize !== undefined) req.pageSize = input.pageSize;
  return req;
}

/**
 * `JSON.stringify` for a value that may be undefined (return a fixed
 * sentinel) or contain functions / cycles (drop those silently). Output
 * is only used as a stable key for change detection, so loss of
 * fidelity is fine.
 */
function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '<unstringifiable>';
  }
}

/**
 * Fetch the companion `<entity>:count` channel and merge `totalCount`
 * into state. Pulled out as a separate function so the main fetch path
 * stays linear; receives the setState dispatcher rather than reaching
 * into hook-local closures.
 */
async function fetchCount<TRow>(args: {
  api: ReturnType<typeof useApi>;
  channel: string;
  filter: unknown;
  search: string;
  myEpoch: number;
  epochRef: { readonly current: number };
  setState: (
    updater: (prev: InternalState<TRow>) => InternalState<TRow>,
  ) => void;
}): Promise<void> {
  const { api, channel, filter, search, myEpoch, epochRef, setState } = args;

  const countChannel = channel.replace(/:list$/, ':count');

  const countCall = (api as Record<string, unknown>)[countChannel] as
    | ((req: { filter?: unknown; search?: string }) => Promise<Result<{ totalCount: number }>>)
    | undefined;

  if (countCall === undefined) {
    // Channel is missing the count companion — surface as an internal
    // error rather than silently dropping the totals strip.
    setState((prev) => ({
      ...prev,
      error: {
        code: 'INTERNAL',
        message: `usePaginatedList: count channel '${countChannel}' not exposed on api.`,
      },
    }));
    return;
  }

  const countReq: { filter?: unknown; search?: string } = {};
  if (filter !== undefined) countReq.filter = filter;
  if (search !== '') countReq.search = search;

  let countResult: Result<{ totalCount: number }>;
  try {
    countResult = await countCall(countReq);
  } catch (e) {
    if (epochRef.current !== myEpoch) return;
    setState((prev) => ({
      ...prev,
      error: {
        code: 'INTERNAL',
        message: e instanceof Error ? e.message : 'Count request threw',
      },
    }));
    return;
  }

  if (epochRef.current !== myEpoch) return;

  if (!countResult.ok) {
    const failure = countResult.error;
    setState((prev) => ({ ...prev, error: failure }));
    return;
  }

  const ok = countResult.value;
  setState((prev) => ({ ...prev, totalCount: ok.totalCount }));
}

// ---------------------------------------------------------------------------
// VirtualizedTable component
// ---------------------------------------------------------------------------

/**
 * Public props for {@link VirtualizedTable}.
 *
 * The component is generic over the channel `C`; `renderRow` receives
 * exactly the row type that channel emits. The static channel binding
 * is what makes the component the single reuse target across products,
 * customers, suppliers, sales, purchases, inventory_movements, audit,
 * journal, and any reports preview that can exceed 200 rows.
 */
export interface VirtualizedTableProps<C extends PaginatedListChannel>
  extends UsePaginatedListParams<C> {
  /** Paginated list channel to drive. */
  readonly channel: C;
  /** Render one row's content. The wrapping element + height come from the table. */
  readonly renderRow: (row: ListRowOf<C>, index: number) => ReactNode;
  /** Per-row height in CSS pixels. Default 48. */
  readonly rowHeight?: number;
  /** Visible-window height in CSS pixels. Default 600. */
  readonly height?: number;
  /**
   * How many rows from the end of the buffer should trigger a
   * `loadMore()` when scrolled into view. Default 10. Set to 0 to
   * disable auto-load; the caller can then drive pagination manually.
   */
  readonly loadMoreThreshold?: number;
  /** Optional empty-state node rendered when no rows have arrived yet. */
  readonly emptyState?: ReactNode;
  /** Optional className applied to the outer wrapper. */
  readonly className?: string;
}

/**
 * Per-row context handed through `react-window`'s `rowProps` channel.
 * `rowProps` re-renders rows whenever a value here changes — which is
 * exactly what we want when the underlying buffer grows.
 */
interface RowContext<TRow> {
  rows: readonly TRow[];
  renderRow: (row: TRow, index: number) => ReactNode;
}

/** `react-window` row component — renders one accumulated row. */
function VirtualizedRow<TRow>(props: RowComponentProps<RowContext<TRow>>): ReactElement | null {
  const { index, style, rows, renderRow } = props;
  const row = rows[index];
  if (row === undefined) return null;
  return (
    <div style={style} role="row" data-row-index={index}>
      {renderRow(row, index)}
    </div>
  );
}

/**
 * Virtualized list view backed by {@link usePaginatedList}.
 *
 * DOM contract (Req 16.5): regardless of how many rows the hook has
 * accumulated, only the rows currently in the visible window plus
 * `react-window`'s overscan margin are mounted. The 10,000-row test in
 * `tests/unit/renderer/components/VirtualizedTable.test.tsx` locks
 * this in.
 */
export function VirtualizedTable<C extends PaginatedListChannel>(
  props: VirtualizedTableProps<C>,
): ReactElement {
  const {
    channel,
    filter,
    search,
    sort,
    pageSize,
    withCount,
    debounceMs,
    enabled,
    renderRow,
    rowHeight = 48,
    height = 600,
    loadMoreThreshold = 10,
    emptyState,
    className,
  } = props;

  // Forward the param subset to the data hook. The hook itself accepts
  // the same shape as `UsePaginatedListParams`; we strip `undefined`s
  // so the call site stays clean under exactOptionalPropertyTypes.
  const hookParams: UsePaginatedListParams<C> = useMemo(
    () => ({
      ...(filter !== undefined ? { filter } : {}),
      ...(search !== undefined ? { search } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(withCount !== undefined ? { withCount } : {}),
      ...(debounceMs !== undefined ? { debounceMs } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    }),
    [filter, search, sort, pageSize, withCount, debounceMs, enabled],
  );

  const data = usePaginatedList<C>(channel, hookParams);

  // Stable handler for `onRowsRendered`. Trigger `loadMore` when the
  // visible stop index reaches within `loadMoreThreshold` rows of the
  // accumulated buffer's tail. The hook short-circuits the call when
  // already loading / exhausted, so spamming the callback is safe.
  const onRowsRendered = useCallback(
    (visible: { startIndex: number; stopIndex: number }): void => {
      if (loadMoreThreshold <= 0) return;
      if (data.exhausted || data.isLoading) return;
      if (visible.stopIndex >= data.rows.length - 1 - loadMoreThreshold) {
        data.loadMore();
      }
    },
    [data, loadMoreThreshold],
  );

  // `rowProps` value — memoize to a stable identity so List doesn't
  // re-render rows on unrelated parent renders, but invalidate when
  // the buffer or render fn changes.
  const rowProps = useMemo<RowContext<ListRowOf<C>>>(
    () => ({ rows: data.rows, renderRow }),
    [data.rows, renderRow],
  );

  const showEmpty = data.rows.length === 0 && !data.isLoading && data.error === null;

  return (
    <div
      className={className}
      data-testid="virtualized-table"
      role="region"
      aria-label="Paginated list"
    >
      <TotalsStrip
        loaded={data.rows.length}
        total={data.totalCount}
        exhausted={data.exhausted}
        isLoading={data.isLoading}
        withCount={withCount === true}
      />

      {data.error !== null ? (
        <div role="alert" data-testid="virtualized-table-error">
          {data.error.code}: {data.error.message}
        </div>
      ) : null}

      {showEmpty ? (
        <div data-testid="virtualized-table-empty">{emptyState ?? 'No results.'}</div>
      ) : (
        <List<RowContext<ListRowOf<C>>>
          rowComponent={VirtualizedRow}
          rowCount={data.rows.length}
          rowHeight={rowHeight}
          rowProps={rowProps}
          defaultHeight={height}
          onRowsRendered={onRowsRendered}
          style={{ height }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Totals strip
// ---------------------------------------------------------------------------

interface TotalsStripProps {
  readonly loaded: number;
  readonly total: number | undefined;
  readonly exhausted: boolean;
  readonly isLoading: boolean;
  readonly withCount: boolean;
}

/**
 * Compact totals indicator. Renders one of three states:
 *   - `Showing N of M` when the count is known.
 *   - `Showing N` when the buffer is exhausted (last page reached).
 *   - `Showing N+` while more pages may follow and the count is unknown.
 */
function TotalsStrip({
  loaded,
  total,
  exhausted,
  isLoading,
  withCount,
}: TotalsStripProps): ReactElement {
  let label: string;
  if (total !== undefined) {
    label = `Showing ${loaded} of ${total}`;
  } else if (exhausted) {
    label = `Showing ${loaded}`;
  } else {
    label = `Showing ${loaded}+`;
  }

  return (
    <div data-testid="virtualized-table-totals" aria-live="polite">
      <span>{label}</span>
      {isLoading ? <span data-testid="virtualized-table-loading"> · loading…</span> : null}
      {withCount && total === undefined && !isLoading ? (
        <span data-testid="virtualized-table-count-pending"> · counting…</span>
      ) : null}
    </div>
  );
}
