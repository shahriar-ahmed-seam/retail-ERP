/**
 * Manual stock adjustment page (task 5.4, Phase 5).
 *
 * Admin-only entry point for the `inventory:adjust` channel
 * (`InventoryService.adjust` in main, Phase 5 task 5.2). The renderer
 * surface mirrors the service's request shape:
 *
 *   - `productId`     — picked via a debounced typeahead over
 *                       `products:list` with a server-side `search`
 *                       filter; results are scoped to the top 10 hits
 *                       so the dropdown stays bounded regardless of
 *                       catalog size.
 *   - `quantityDelta` — signed integer; positive values increment,
 *                       negative values decrement. Zero is rejected
 *                       (the public adjust surface has no business
 *                       semantics for "no change", and the service
 *                       returns `Err('VALIDATION', { field:
 *                       'quantityDelta' })` for it anyway).
 *   - `reason`        — free-form text persisted to the audit log
 *                       (Req 13.3); 1–200 chars, trimmed.
 *
 * Role gating (Req 3.5, 8.2): only the `Admin` role reaches the form.
 * Cashiers — and unauthenticated renderers — see a permission-denied
 * message instead. Defence-in-depth: the IPC matrix already denies
 * `inventory:adjust` for cashiers (writes an `rbac.deny` audit row,
 * Req 8.4), but rendering the form for a role that cannot submit it
 * would be a confusing UX.
 *
 * Server-error mapping (`InventoryService.adjust` envelopes):
 *
 *   - `VALIDATION { field }`        → inline message next to the
 *                                    offending field (`productId`,
 *                                    `quantityDelta`, or `reason`).
 *   - `OUT_OF_STOCK { productId }`  → inline message under the delta
 *                                    input (the stock-availability
 *                                    constraint is the user's reason
 *                                    to revisit the delta value).
 *   - `FK_VIOLATION { reason }`     → inline under the product picker
 *                                    ("product not found").
 *   - `INTERNAL` / `UNAUTHENTICATED` are surfaced as toasts by the
 *     `useApi()` wrapper (`src/renderer/lib/api.ts`); the form itself
 *     does not re-render them.
 *   - Anything else falls through to the page-level banner so the
 *     code + message stay legible.
 *
 * Successful submit:
 *
 *   - Clears every form field (selected product, delta, reason).
 *   - Renders an aria-live success indicator with the returned
 *     `movementId` so an admin can quote it during reconciliation.
 *     Once a richer toast UX lands in task 13.4 the inline indicator
 *     can be retired without touching this component's submit flow.
 *   - Calls the optional `onAdjusted(movementId)` parent callback so
 *     a wrapper (e.g. the upcoming inventory dashboard in task 5.5.2)
 *     can refresh the movements list and the low-stock banner.
 *
 * Validates: Requirements 3.5, 8.2, 13.3.
 */

import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';

import { useApi } from '@renderer/lib/api';
import { useAuth } from '@renderer/lib/auth-context';

import type { AdjustmentInput, ProductDTO } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface AdjustPageProps {
  /**
   * Optional parent callback fired after a successful adjustment.
   * Receives the returned `movementId` so the parent can correlate
   * the new ledger row with whatever list / banner state it refreshes
   * (e.g. low-stock banner, movements browser).
   */
  readonly onAdjusted?: (movementId: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the product typeahead (Req 16.1, design.md > "Server-side filter, search, sort"). */
const SEARCH_DEBOUNCE_MS = 250;

/** Bound on the typeahead result list so the dropdown never explodes. */
const SEARCH_PAGE_SIZE = 10;

/** Application-level bounds on the reason text. Mirrors `validateAdjustInput` in main. */
const REASON_MIN = 1;
const REASON_MAX = 200;

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

/**
 * Public entry point. Splits the role gate from the form body so the
 * form can use hooks without violating React's hooks-order invariant
 * across the gated branch.
 */
export function AdjustPage(props: AdjustPageProps): ReactElement {
  const { session } = useAuth();

  if (session?.role !== 'Admin') {
    return <PermissionDenied />;
  }

  return <AdjustPageInner {...props} />;
}

// ---------------------------------------------------------------------------
// Permission-denied fallback
// ---------------------------------------------------------------------------

function PermissionDenied(): ReactElement {
  return (
    <main
      role="alert"
      data-testid="adjust-permission-denied"
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        maxWidth: '32rem',
        margin: '4rem auto',
        textAlign: 'center',
        color: '#555',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>Permission denied</h1>
      <p>
        Manual stock adjustments are restricted to the Admin role. Please sign
        in as an administrator to continue.
      </p>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Form body
// ---------------------------------------------------------------------------

interface SuccessNotice {
  readonly movementId: string;
  /** Productive readback so the success indicator names what just happened. */
  readonly productName: string;
  readonly delta: number;
}

function AdjustPageInner({ onAdjusted }: AdjustPageProps): ReactElement {
  const api = useApi();
  const idPrefix = useId();

  // ----- Form state -------------------------------------------------------
  const [selectedProduct, setSelectedProduct] = useState<ProductDTO | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<ErrorEnvelope | null>(null);
  const [success, setSuccess] = useState<SuccessNotice | null>(null);

  // ----- Typeahead state --------------------------------------------------
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<readonly ProductDTO[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Debounce the typeahead query. Mirrors the convention used by
  // `usePaginatedList` so the renderer never floods the IPC bridge
  // mid-keystroke.
  useEffect(() => {
    if (query === debouncedQuery) return undefined;
    const handle = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [query, debouncedQuery]);

  // Run the typeahead search when the debounced query changes. Skip
  // entirely when a product is already selected (the input is hidden
  // in that branch) or the query is empty.
  useEffect(() => {
    if (selectedProduct !== null) return undefined;
    const trimmed = debouncedQuery.trim();
    if (trimmed.length === 0) {
      setSearchResults([]);
      setIsSearching(false);
      return undefined;
    }

    let cancelled = false;
    setIsSearching(true);
    void (async () => {
      const result = await api['products:list']({
        search: trimmed,
        pageSize: SEARCH_PAGE_SIZE,
      });
      if (cancelled) return;
      setIsSearching(false);
      if (result.ok) {
        setSearchResults(result.value.rows);
      } else {
        setSearchResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, debouncedQuery, selectedProduct]);

  // ----- Validation ------------------------------------------------------
  const trimmedDelta = delta.trim();
  const parsedDelta = /^-?\d+$/.test(trimmedDelta) ? Number.parseInt(trimmedDelta, 10) : NaN;
  const isDeltaValid = Number.isInteger(parsedDelta) && parsedDelta !== 0;
  const trimmedReason = reason.trim();
  const isReasonValid =
    trimmedReason.length >= REASON_MIN && trimmedReason.length <= REASON_MAX;
  const canSubmit =
    !submitting && selectedProduct !== null && isDeltaValid && isReasonValid;

  // ----- Selection handlers ----------------------------------------------
  const selectProduct = useCallback((p: ProductDTO): void => {
    setSelectedProduct(p);
    setQuery('');
    setDebouncedQuery('');
    setSearchResults([]);
    setServerError(null);
  }, []);

  const clearProduct = useCallback((): void => {
    setSelectedProduct(null);
    setServerError(null);
  }, []);

  // ----- Submit ----------------------------------------------------------
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!canSubmit) return;
      if (selectedProduct === null) return;
      if (!Number.isInteger(parsedDelta)) return;

      const payload: AdjustmentInput = {
        productId: selectedProduct.id,
        quantityDelta: parsedDelta,
        reason: trimmedReason,
      };

      setSubmitting(true);
      setServerError(null);
      setSuccess(null);

      void (async () => {
        try {
          const result = await api['inventory:adjust'](payload);
          if (result.ok) {
            // Snapshot the success context BEFORE we clear the form
            // so the success indicator has a name to render against.
            setSuccess({
              movementId: result.value.movementId,
              productName: selectedProduct.name,
              delta: parsedDelta,
            });
            // Clear every input so the next adjustment starts fresh.
            setSelectedProduct(null);
            setDelta('');
            setReason('');
            setQuery('');
            setDebouncedQuery('');
            setSearchResults([]);
            onAdjusted?.(result.value.movementId);
            return;
          }
          setServerError(result.error);
        } finally {
          setSubmitting(false);
        }
      })();
    },
    [api, canSubmit, onAdjusted, parsedDelta, selectedProduct, trimmedReason],
  );

  // ----- Per-field server-error reading ----------------------------------
  // The service writes `{ field: 'productId' | 'quantityDelta' | 'reason' }`
  // for VALIDATION envelopes; OUT_OF_STOCK targets the delta input
  // implicitly (it's the stock-side constraint); FK_VIOLATION targets
  // the product picker.
  const errorField = readErrorField(serverError);

  // ----- Render ----------------------------------------------------------
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '36rem',
        margin: '0 auto',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>Adjust stock</h1>
      <p style={{ marginBottom: '1.5rem', color: '#555' }}>
        Record a manual stock adjustment. Positive deltas increase stock,
        negative deltas decrease stock. The reason is written to the audit
        log.
      </p>

      <form onSubmit={handleSubmit} noValidate>
        {/* Product picker --------------------------------------------- */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor={`${idPrefix}-product-search`}
            style={{ display: 'block', marginBottom: '0.25rem' }}
          >
            Product <span aria-hidden="true">*</span>
          </label>

          {selectedProduct === null ? (
            <ProductTypeahead
              inputId={`${idPrefix}-product-search`}
              query={query}
              onQueryChange={setQuery}
              results={searchResults}
              isSearching={isSearching}
              onSelect={selectProduct}
              error={
                errorField === 'productId' ||
                (serverError?.code === 'FK_VIOLATION' &&
                  (serverError.details as { reason?: string } | undefined)?.reason ===
                    'not_found')
                  ? serverError?.code === 'FK_VIOLATION'
                    ? 'Product not found.'
                    : (serverError?.message ?? null)
                  : null
              }
            />
          ) : (
            <SelectedProductCard
              product={selectedProduct}
              onClear={clearProduct}
            />
          )}
        </div>

        {/* Delta ------------------------------------------------------- */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor={`${idPrefix}-delta`}
            style={{ display: 'block', marginBottom: '0.25rem' }}
          >
            Quantity delta <span aria-hidden="true">*</span>
          </label>
          <input
            id={`${idPrefix}-delta`}
            data-testid="adjust-delta"
            type="text"
            inputMode="numeric"
            placeholder="e.g. -2 or 5"
            required
            value={delta}
            onChange={(e) => {
              setDelta(e.target.value);
              setServerError(null);
            }}
            aria-invalid={
              errorField === 'quantityDelta' ||
              serverError?.code === 'OUT_OF_STOCK' ||
              undefined
            }
            aria-describedby={
              errorField === 'quantityDelta' || serverError?.code === 'OUT_OF_STOCK'
                ? `${idPrefix}-delta-error`
                : undefined
            }
            style={{
              width: '100%',
              padding: '0.5rem',
              boxSizing: 'border-box',
            }}
          />
          {errorField === 'quantityDelta' ? (
            <FieldError id={`${idPrefix}-delta-error`} testId="adjust-delta-error">
              {serverError?.message ?? 'Invalid quantity.'}
            </FieldError>
          ) : null}
          {serverError?.code === 'OUT_OF_STOCK' ? (
            <FieldError
              id={`${idPrefix}-delta-error`}
              testId="adjust-out-of-stock-error"
            >
              Adjustment would put on-hand stock below zero.
            </FieldError>
          ) : null}
        </div>

        {/* Reason ------------------------------------------------------ */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor={`${idPrefix}-reason`}
            style={{ display: 'block', marginBottom: '0.25rem' }}
          >
            Reason <span aria-hidden="true">*</span>
          </label>
          <textarea
            id={`${idPrefix}-reason`}
            data-testid="adjust-reason"
            required
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setServerError(null);
            }}
            aria-invalid={errorField === 'reason' || undefined}
            aria-describedby={
              errorField === 'reason' ? `${idPrefix}-reason-error` : undefined
            }
            style={{
              width: '100%',
              padding: '0.5rem',
              boxSizing: 'border-box',
              resize: 'vertical',
            }}
          />
          {errorField === 'reason' ? (
            <FieldError id={`${idPrefix}-reason-error`} testId="adjust-reason-error">
              {serverError?.message ?? 'Reason is required.'}
            </FieldError>
          ) : null}
        </div>

        {/* Page-level banner for non-field envelopes */}
        {serverError !== null &&
        errorField === null &&
        serverError.code !== 'OUT_OF_STOCK' &&
        serverError.code !== 'FK_VIOLATION' ? (
          <div
            role="alert"
            data-testid="adjust-banner"
            style={{
              marginTop: '0.5rem',
              marginBottom: '1rem',
              padding: '0.75rem',
              border: '1px solid #c33',
              color: '#c33',
              background: '#fff5f5',
              borderRadius: 4,
            }}
          >
            <strong>{serverError.code}</strong>
            <div>{serverError.message}</div>
          </div>
        ) : null}

        {/* Success indicator */}
        {success !== null ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="adjust-success"
            style={{
              marginTop: '0.5rem',
              marginBottom: '1rem',
              padding: '0.75rem',
              border: '1px solid #2a8',
              color: '#1a6',
              background: '#f3fff7',
              borderRadius: 4,
            }}
          >
            <strong>Stock adjusted</strong>
            <div>
              {success.delta > 0 ? '+' : ''}
              {success.delta} on {success.productName} (movement{' '}
              {success.movementId})
            </div>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          data-testid="adjust-submit"
          style={{
            padding: '0.625rem 1.25rem',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Saving…' : 'Apply adjustment'}
        </button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Product typeahead
// ---------------------------------------------------------------------------

interface ProductTypeaheadProps {
  readonly inputId: string;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly results: readonly ProductDTO[];
  readonly isSearching: boolean;
  readonly onSelect: (product: ProductDTO) => void;
  /** Inline error message to render under the input, if any. */
  readonly error: string | null;
}

function ProductTypeahead({
  inputId,
  query,
  onQueryChange,
  results,
  isSearching,
  onSelect,
  error,
}: ProductTypeaheadProps): ReactElement {
  const errorId = error !== null ? `${inputId}-error` : undefined;
  const showResults = query.trim().length > 0;
  return (
    <div>
      <input
        id={inputId}
        data-testid="adjust-product-search"
        type="search"
        autoComplete="off"
        placeholder="Search by name or SKU"
        value={query}
        onChange={(e) => {
          onQueryChange(e.target.value);
        }}
        aria-invalid={error !== null || undefined}
        aria-describedby={errorId}
        style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
      />
      {error !== null ? (
        <div
          id={errorId}
          role="alert"
          data-testid="adjust-product-error"
          style={{ marginTop: '0.25rem', color: '#c33', fontSize: '0.875rem' }}
        >
          {error}
        </div>
      ) : null}
      {showResults ? (
        <ul
          role="listbox"
          aria-label="Product search results"
          data-testid="adjust-product-results"
          style={{
            listStyle: 'none',
            margin: '0.25rem 0 0',
            padding: 0,
            border: '1px solid #ddd',
            borderRadius: 4,
            maxHeight: '14rem',
            overflowY: 'auto',
          }}
        >
          {isSearching && results.length === 0 ? (
            <li
              data-testid="adjust-product-results-loading"
              style={{ padding: '0.5rem 0.75rem', color: '#777' }}
            >
              Searching…
            </li>
          ) : null}
          {!isSearching && results.length === 0 ? (
            <li
              data-testid="adjust-product-results-empty"
              style={{ padding: '0.5rem 0.75rem', color: '#777' }}
            >
              No matching products.
            </li>
          ) : null}
          {results.map((p) => (
            <li key={p.id} role="option" aria-selected="false">
              <button
                type="button"
                data-testid={`adjust-product-result-${p.id}`}
                onClick={() => {
                  onSelect(p);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '0.5rem 0.75rem',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid #eee',
                  cursor: 'pointer',
                }}
              >
                <strong>{p.name}</strong>
                <span style={{ color: '#777', marginLeft: '0.5rem' }}>
                  {p.sku} · on hand {p.onHand}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selected product card
// ---------------------------------------------------------------------------

interface SelectedProductCardProps {
  readonly product: ProductDTO;
  readonly onClear: () => void;
}

function SelectedProductCard({
  product,
  onClear,
}: SelectedProductCardProps): ReactElement {
  return (
    <div
      data-testid="adjust-selected-product"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        border: '1px solid #cde',
        background: '#f3f8ff',
        borderRadius: 4,
      }}
    >
      <div>
        <strong data-testid="adjust-selected-product-name">{product.name}</strong>
        <div style={{ color: '#555', fontSize: '0.875rem' }}>
          {product.sku} · on hand {product.onHand}
        </div>
      </div>
      <button
        type="button"
        onClick={onClear}
        data-testid="adjust-selected-product-clear"
        style={{ padding: '0.25rem 0.5rem' }}
      >
        Change
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field error
// ---------------------------------------------------------------------------

interface FieldErrorProps {
  readonly id: string;
  readonly testId: string;
  readonly children: string;
}

function FieldError({ id, testId, children }: FieldErrorProps): ReactElement {
  return (
    <div
      id={id}
      role="alert"
      data-testid={testId}
      style={{ marginTop: '0.25rem', color: '#c33', fontSize: '0.875rem' }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull the offending field name out of an `ErrorEnvelope` for VALIDATION
 * envelopes. Returns one of the three known field names or `null`. Other
 * envelopes (OUT_OF_STOCK, FK_VIOLATION, INTERNAL, …) are not field-scoped
 * and are handled by the call site.
 */
function readErrorField(
  error: ErrorEnvelope | null,
): 'productId' | 'quantityDelta' | 'reason' | null {
  if (error === null) return null;
  if (error.code !== 'VALIDATION') return null;
  const details = error.details;
  if (details === undefined) return null;
  const field = (details as { field?: unknown }).field;
  if (field === 'productId' || field === 'quantityDelta' || field === 'reason') {
    return field;
  }
  return null;
}
