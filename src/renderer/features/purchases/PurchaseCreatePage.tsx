/**
 * Purchase create page (task 6.3, Phase 6).
 *
 * Admin-only entry point for the `purchase:create` channel
 * (`PurchaseService.create` in main, Phase 6 task 6.2). The renderer
 * surface mirrors the service's `PurchaseInput` request shape:
 *
 *   - `supplierId`  — picked via a debounced typeahead over
 *                     `suppliers:list` with `search` + `pageSize: 20`.
 *                     Required. Once selected, the input collapses to
 *                     a card with a "Change" affordance.
 *   - `invoiceNo`   — optional free-text, trimmed and length-capped at
 *                     50 client-side. Empty → `null` on the wire so the
 *                     persisted column matches the schema default.
 *   - `items[]`     — at least one line. Each line carries:
 *                       * `productId` (typeahead via `products:list`),
 *                       * `quantity`  (integer ≥ 1),
 *                       * `unitBuyPrice` (string field; raw user input
 *                         forwarded verbatim — `'12.50'` stays `'12.50'`
 *                         because the wire format is `Prisma.Decimal`-
 *                         compatible string and any client-side
 *                         normalization risks losing precision).
 *
 * Server-error mapping (`PurchaseService.create` envelopes):
 *
 *   - `VALIDATION { field }`            → inline next to the offending
 *     input. The `field` shape is either `<top-level>` (e.g.
 *     `'supplierId'`, `'invoiceNo'`, `'items'`) or
 *     `'items[N].<key>'` for a per-line field. The latter is parsed
 *     into `{ index, field }` so the line at row `N` highlights
 *     exactly the offending input.
 *   - `VALIDATION` with no `field`       → page-level alert region.
 *   - `FK_VIOLATION`                    → page-level alert with the
 *     "supplier or product not found — please refresh and try again."
 *     copy. The service maps both `P2003` (FK violation on supplier or
 *     product FK) and `P2025` (record-not-found while reading the
 *     inventory row inside `applyMovement`) to this code, so we treat
 *     them uniformly without branching.
 *   - `INTERNAL` / `UNAUTHENTICATED`    → surfaced as toasts by the
 *     `useApi()` wrapper; the form re-displays the envelope code +
 *     message in the alert region too so the user has something to
 *     read.
 *
 * Successful submit:
 *
 *   - Clears every form field (supplier, invoice, items).
 *   - Renders an aria-live success indicator carrying the new
 *     `purchaseId`. Real navigation lands with the route tree (task
 *     13.1); for now the success banner is the confirmation surface.
 *
 * Validates: Requirements 5.1, 5.2, 5.3.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';

import { useApi } from '@renderer/lib/api';

import type {
  ProductDTO,
  PurchaseInput,
  SupplierDTO,
} from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the supplier and product typeaheads. Mirrors
 *  AdjustPage / MovementsBrowserPage / `usePaginatedList`. */
const SEARCH_DEBOUNCE_MS = 250;

/** Bound on the typeahead result list so the dropdown stays bounded. */
const SEARCH_PAGE_SIZE = 20;

/** Application-level bound on the optional `invoiceNo` field. Mirrors
 *  the server-side bound in `purchase.service.ts` so the renderer
 *  surfaces the rejection inline before round-tripping. */
const INVOICE_NO_MAX = 50;

// ---------------------------------------------------------------------------
// Item line state
// ---------------------------------------------------------------------------

/**
 * Per-line state owned by the parent form. Each line carries its own
 * stable `key` (used as the React `key` so removing a middle line
 * doesn't shift identity) plus the editable values. The product
 * typeahead's transient state (query, debounced query, results) is
 * encapsulated inside the line component so the parent does not need
 * to track it across all lines.
 */
interface LineState {
  readonly key: string;
  readonly product: ProductDTO | null;
  readonly quantity: string;
  readonly unitBuyPrice: string;
}

/**
 * Build a fresh empty line. The `key` is opaque — only React reads it
 * — so a monotonic counter is sufficient and avoids depending on
 * `crypto.randomUUID()` (not guaranteed across Node versions in jsdom).
 */
function makeBlankLine(key: string): LineState {
  return { key, product: null, quantity: '1', unitBuyPrice: '' };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const INT_RE = /^\d+$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Quantity validator. Mirrors the server: integer ≥ 1. */
function isQuantityValid(raw: string): boolean {
  const trimmed = raw.trim();
  if (!INT_RE.test(trimmed)) return false;
  const n = Number.parseInt(trimmed, 10);
  return Number.isInteger(n) && n >= 1;
}

/** Unit buy price validator. Mirrors the server: non-negative decimal. */
function isUnitBuyPriceValid(raw: string): boolean {
  return DECIMAL_RE.test(raw.trim());
}

/** Compute one line's total to two decimals. Returns `'0.00'` whenever
 *  either input fails to parse so the readonly cell never shows `NaN`. */
function computeLineTotal(line: LineState): string {
  const q = Number.parseInt(line.quantity.trim(), 10);
  const p = Number.parseFloat(line.unitBuyPrice.trim());
  if (!Number.isFinite(q) || !Number.isFinite(p) || q < 0 || p < 0) {
    return '0.00';
  }
  return (q * p).toFixed(2);
}

/** Grand total = sum of the per-line products. */
function computeGrandTotal(lines: readonly LineState[]): string {
  let total = 0;
  for (const line of lines) {
    const q = Number.parseInt(line.quantity.trim(), 10);
    const p = Number.parseFloat(line.unitBuyPrice.trim());
    if (Number.isFinite(q) && Number.isFinite(p) && q >= 0 && p >= 0) {
      total += q * p;
    }
  }
  return total.toFixed(2);
}

/** Check whether the form is internally consistent enough to submit. */
function canSubmit(opts: {
  supplier: SupplierDTO | null;
  invoiceNo: string;
  lines: readonly LineState[];
  submitting: boolean;
}): boolean {
  if (opts.submitting) return false;
  if (opts.supplier === null) return false;
  if (opts.lines.length === 0) return false;
  if (opts.invoiceNo.trim().length > INVOICE_NO_MAX) return false;
  for (const line of opts.lines) {
    if (line.product === null) return false;
    if (!isQuantityValid(line.quantity)) return false;
    if (!isUnitBuyPriceValid(line.unitBuyPrice)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Server-error parsing
// ---------------------------------------------------------------------------

/**
 * Parsed shape of a `VALIDATION { field }` envelope. The service writes
 * either a top-level field name (`'supplierId'`, `'invoiceNo'`, `'items'`)
 * or an indexed per-item field (`'items[N].productId'` /
 * `'items[N].quantity'` / `'items[N].unitBuyPrice'`).
 */
type ValidationField =
  | { kind: 'top'; field: string }
  | { kind: 'item'; index: number; field: string };

/**
 * Pull the `field` discriminator out of an `ErrorEnvelope`, classifying
 * it as either top-level (e.g. `'supplierId'`, `'invoiceNo'`, `'items'`)
 * or per-item (`'items[N].<key>'`). Returns `null` for envelopes that
 * are not VALIDATION or that omit `details.field`.
 */
function readValidationField(error: ErrorEnvelope | null): ValidationField | null {
  if (error === null) return null;
  if (error.code !== 'VALIDATION') return null;
  const details = error.details;
  if (details === undefined) return null;
  const field = (details as { field?: unknown }).field;
  if (typeof field !== 'string' || field.length === 0) return null;

  const m = /^items\[(\d+)\]\.(\w+)$/.exec(field);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    return { kind: 'item', index: Number.parseInt(m[1], 10), field: m[2] };
  }
  return { kind: 'top', field };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PurchaseCreatePageProps {
  /**
   * Optional callback fired after a successful submit. Receives the
   * new `purchaseId` so a parent (e.g. the upcoming router in task
   * 13.1) can refresh the recent-purchases list or navigate to the
   * detail screen.
   */
  readonly onCreated?: (purchaseId: string) => void;
}

interface SuccessNotice {
  readonly purchaseId: string;
}

export function PurchaseCreatePage(
  { onCreated }: PurchaseCreatePageProps = {},
): ReactElement {
  const api = useApi();
  const idPrefix = useId();

  // ----- Stable line-key counter -----------------------------------------
  // React needs each row's key to be stable across re-renders and unique
  // within the list. A monotonic counter held in a ref is sufficient:
  // removing a middle line never shifts a sibling's key.
  const lineKeyCounter = useRef(0);
  const nextLineKey = useCallback((): string => {
    lineKeyCounter.current += 1;
    return `line-${String(lineKeyCounter.current)}`;
  }, []);

  // ----- Form state -------------------------------------------------------
  const [supplier, setSupplier] = useState<SupplierDTO | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [lines, setLines] = useState<readonly LineState[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<ErrorEnvelope | null>(null);
  const [success, setSuccess] = useState<SuccessNotice | null>(null);

  // ----- Supplier typeahead state ----------------------------------------
  const [supplierQuery, setSupplierQuery] = useState('');
  const [debouncedSupplierQuery, setDebouncedSupplierQuery] = useState('');
  const [supplierResults, setSupplierResults] = useState<readonly SupplierDTO[]>([]);
  const [isSearchingSupplier, setIsSearchingSupplier] = useState(false);

  // Debounce supplier search (mirrors AdjustPage / `usePaginatedList`).
  useEffect(() => {
    if (supplierQuery === debouncedSupplierQuery) return undefined;
    const handle = setTimeout(() => {
      setDebouncedSupplierQuery(supplierQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [supplierQuery, debouncedSupplierQuery]);

  // Run the supplier search against `suppliers:list` once the
  // debounced query settles. Skip when a supplier is already selected
  // (the input is hidden in that branch) or the query is empty.
  useEffect(() => {
    if (supplier !== null) return undefined;
    const trimmed = debouncedSupplierQuery.trim();
    if (trimmed.length === 0) {
      setSupplierResults([]);
      setIsSearchingSupplier(false);
      return undefined;
    }
    let cancelled = false;
    setIsSearchingSupplier(true);
    void (async () => {
      const result = await api['suppliers:list']({
        search: trimmed,
        pageSize: SEARCH_PAGE_SIZE,
      });
      if (cancelled) return;
      setIsSearchingSupplier(false);
      if (result.ok) {
        setSupplierResults(result.value.rows);
      } else {
        setSupplierResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, debouncedSupplierQuery, supplier]);

  const selectSupplier = useCallback((s: SupplierDTO): void => {
    setSupplier(s);
    setSupplierQuery('');
    setDebouncedSupplierQuery('');
    setSupplierResults([]);
    setServerError(null);
    setSuccess(null);
  }, []);

  const clearSupplier = useCallback((): void => {
    setSupplier(null);
    setServerError(null);
  }, []);

  // ----- Item line operations --------------------------------------------
  const addLine = useCallback((): void => {
    setLines((prev) => [...prev, makeBlankLine(nextLineKey())]);
    setSuccess(null);
  }, [nextLineKey]);

  const removeLine = useCallback((index: number): void => {
    setLines((prev) => prev.filter((_, i) => i !== index));
    setServerError(null);
  }, []);

  const setLineProduct = useCallback(
    (index: number, product: ProductDTO | null): void => {
      setLines((prev) =>
        prev.map((line, i) => (i === index ? { ...line, product } : line)),
      );
      setServerError(null);
    },
    [],
  );

  const setLineQuantity = useCallback((index: number, quantity: string): void => {
    setLines((prev) =>
      prev.map((line, i) => (i === index ? { ...line, quantity } : line)),
    );
    setServerError(null);
  }, []);

  const setLineUnitBuyPrice = useCallback(
    (index: number, unitBuyPrice: string): void => {
      setLines((prev) =>
        prev.map((line, i) => (i === index ? { ...line, unitBuyPrice } : line)),
      );
      setServerError(null);
    },
    [],
  );

  // ----- Submit ----------------------------------------------------------
  const submitAllowed = canSubmit({ supplier, invoiceNo, lines, submitting });

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!submitAllowed || supplier === null) return;

      const trimmedInvoice = invoiceNo.trim();
      const payload: PurchaseInput = {
        supplierId: supplier.id,
        invoiceNo: trimmedInvoice === '' ? null : trimmedInvoice,
        items: lines.map((line) => ({
          // The `product === null` branch is excluded by `submitAllowed`
          // above, but TypeScript needs a non-null assertion here.
          productId: line.product?.id ?? '',
          quantity: Number.parseInt(line.quantity.trim(), 10),
          unitBuyPrice: line.unitBuyPrice.trim(),
        })),
      };

      setSubmitting(true);
      setServerError(null);
      setSuccess(null);

      void (async () => {
        try {
          const result = await api['purchase:create'](payload);
          if (result.ok) {
            const purchaseId = result.value.purchaseId;
            // Clear the form so the next purchase starts fresh.
            setSupplier(null);
            setInvoiceNo('');
            setLines([]);
            setSupplierQuery('');
            setDebouncedSupplierQuery('');
            setSupplierResults([]);
            setSuccess({ purchaseId });
            onCreated?.(purchaseId);
            return;
          }
          setServerError(result.error);
        } finally {
          setSubmitting(false);
        }
      })();
    },
    [api, invoiceNo, lines, onCreated, submitAllowed, supplier],
  );

  // ----- Server-error classification -------------------------------------
  const validationField = readValidationField(serverError);
  const isFkViolation = serverError !== null && serverError.code === 'FK_VIOLATION';

  // Does the page-level banner have anything to show? Per-field
  // VALIDATION envelopes are rendered inline; everything else falls
  // through to the banner.
  const showPageBanner =
    serverError !== null &&
    validationField?.kind !== 'item' &&
    validationField?.kind !== 'top';

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '54rem',
        margin: '0 auto',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>New purchase</h1>
      <p style={{ marginTop: 0, marginBottom: '1.25rem', color: '#555' }}>
        Record a purchase invoice. Stock is incremented atomically when the
        purchase is saved.
      </p>

      <form onSubmit={handleSubmit} noValidate>
        {/* Supplier picker ----------------------------------------- */}
        <section style={{ marginBottom: '1.25rem' }}>
          <label
            htmlFor={`${idPrefix}-supplier-search`}
            style={{ display: 'block', marginBottom: '0.25rem' }}
          >
            Supplier <span aria-hidden="true">*</span>
          </label>
          {supplier === null ? (
            <SupplierTypeahead
              inputId={`${idPrefix}-supplier-search`}
              query={supplierQuery}
              onQueryChange={setSupplierQuery}
              results={supplierResults}
              isSearching={isSearchingSupplier}
              onSelect={selectSupplier}
              error={
                validationField?.kind === 'top' && validationField.field === 'supplierId'
                  ? (serverError?.message ?? 'Supplier is required.')
                  : null
              }
            />
          ) : (
            <SelectedSupplierCard supplier={supplier} onClear={clearSupplier} />
          )}
        </section>

        {/* Invoice number ------------------------------------------ */}
        <section style={{ marginBottom: '1.25rem' }}>
          <label
            htmlFor={`${idPrefix}-invoice-no`}
            style={{ display: 'block', marginBottom: '0.25rem' }}
          >
            Invoice number (optional)
          </label>
          <input
            id={`${idPrefix}-invoice-no`}
            data-testid="purchase-create-invoice-no"
            type="text"
            value={invoiceNo}
            maxLength={INVOICE_NO_MAX}
            onChange={(e) => {
              setInvoiceNo(e.target.value);
              setServerError(null);
            }}
            aria-invalid={
              validationField?.kind === 'top' && validationField.field === 'invoiceNo'
                ? true
                : undefined
            }
            aria-describedby={
              validationField?.kind === 'top' && validationField.field === 'invoiceNo'
                ? `${idPrefix}-invoice-no-error`
                : undefined
            }
            style={{
              width: '100%',
              padding: '0.5rem',
              boxSizing: 'border-box',
            }}
          />
          {validationField?.kind === 'top' && validationField.field === 'invoiceNo' ? (
            <FieldError
              id={`${idPrefix}-invoice-no-error`}
              testId="purchase-create-invoice-no-error"
            >
              {serverError?.message ?? 'Invalid invoice number.'}
            </FieldError>
          ) : null}
        </section>

        {/* Items ---------------------------------------------------- */}
        <section style={{ marginBottom: '1rem' }}>
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '0.5rem',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '1.125rem' }}>Items</h2>
            <button
              type="button"
              onClick={addLine}
              data-testid="purchase-create-add-line"
              style={{ padding: '0.375rem 0.75rem' }}
            >
              Add line
            </button>
          </header>

          {validationField?.kind === 'top' && validationField.field === 'items' ? (
            <FieldError
              id={`${idPrefix}-items-error`}
              testId="purchase-create-items-error"
            >
              {serverError?.message ?? 'At least one item is required.'}
            </FieldError>
          ) : null}

          {lines.length === 0 ? (
            <div
              data-testid="purchase-create-no-lines"
              style={{
                padding: '1.25rem',
                textAlign: 'center',
                color: '#666',
                border: '1px dashed #ccc',
                borderRadius: 4,
              }}
            >
              No lines yet. Click &ldquo;Add line&rdquo; to start.
            </div>
          ) : (
            <div
              role="table"
              data-testid="purchase-create-lines-table"
              style={{
                border: '1px solid #ddd',
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <LineTableHeader />
              {lines.map((line, index) => (
                <PurchaseLineRow
                  key={line.key}
                  index={index}
                  line={line}
                  onProductChange={(p) => {
                    setLineProduct(index, p);
                  }}
                  onQuantityChange={(v) => {
                    setLineQuantity(index, v);
                  }}
                  onUnitBuyPriceChange={(v) => {
                    setLineUnitBuyPrice(index, v);
                  }}
                  onRemove={() => {
                    removeLine(index);
                  }}
                  validationField={
                    validationField?.kind === 'item' && validationField.index === index
                      ? validationField.field
                      : null
                  }
                  validationMessage={
                    validationField?.kind === 'item' && validationField.index === index
                      ? (serverError?.message ?? null)
                      : null
                  }
                />
              ))}
            </div>
          )}
        </section>

        {/* Footer: grand total + submit ---------------------------- */}
        <footer
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            marginTop: '1.5rem',
            padding: '0.75rem 1rem',
            background: '#f7f7f7',
            border: '1px solid #ddd',
            borderRadius: 4,
          }}
        >
          <div>
            <span style={{ color: '#555' }}>Total: </span>
            <strong
              data-testid="purchase-create-grand-total"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {computeGrandTotal(lines)}
            </strong>
          </div>
          <button
            type="submit"
            disabled={!submitAllowed}
            data-testid="purchase-create-submit"
            style={{
              padding: '0.625rem 1.25rem',
              cursor: submitAllowed ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? 'Saving…' : 'Save purchase'}
          </button>
        </footer>

        {/* Page-level banner --------------------------------------- */}
        {showPageBanner && serverError !== null ? (
          <div
            role="alert"
            data-testid="purchase-create-banner"
            style={{
              marginTop: '1rem',
              padding: '0.75rem',
              border: '1px solid #c33',
              color: '#c33',
              background: '#fff5f5',
              borderRadius: 4,
            }}
          >
            <strong>{serverError.code}</strong>
            <div>
              {isFkViolation
                ? 'Supplier or product not found — please refresh and try again.'
                : serverError.message}
            </div>
          </div>
        ) : null}

        {/* Success banner ------------------------------------------ */}
        {success !== null ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="purchase-create-success"
            style={{
              marginTop: '1rem',
              padding: '0.75rem',
              border: '1px solid #2a8',
              color: '#1a6',
              background: '#f3fff7',
              borderRadius: 4,
            }}
          >
            <strong>Purchase recorded</strong>
            <div>
              Purchase ID:{' '}
              <span data-testid="purchase-create-success-id">{success.purchaseId}</span>
            </div>
          </div>
        ) : null}
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Supplier typeahead
// ---------------------------------------------------------------------------

interface SupplierTypeaheadProps {
  readonly inputId: string;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly results: readonly SupplierDTO[];
  readonly isSearching: boolean;
  readonly onSelect: (supplier: SupplierDTO) => void;
  readonly error: string | null;
}

function SupplierTypeahead({
  inputId,
  query,
  onQueryChange,
  results,
  isSearching,
  onSelect,
  error,
}: SupplierTypeaheadProps): ReactElement {
  const errorId = error !== null ? `${inputId}-error` : undefined;
  const showResults = query.trim().length > 0;
  return (
    <div>
      <input
        id={inputId}
        data-testid="purchase-create-supplier-search"
        type="search"
        autoComplete="off"
        placeholder="Search suppliers by name"
        value={query}
        onChange={(e) => {
          onQueryChange(e.target.value);
        }}
        aria-invalid={error !== null || undefined}
        aria-describedby={errorId}
        style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
      />
      {error !== null ? (
        <FieldError
          id={errorId ?? `${inputId}-error`}
          testId="purchase-create-supplier-error"
        >
          {error}
        </FieldError>
      ) : null}
      {showResults ? (
        <ul
          role="listbox"
          aria-label="Supplier search results"
          data-testid="purchase-create-supplier-results"
          style={{
            listStyle: 'none',
            margin: '0.25rem 0 0',
            padding: 0,
            border: '1px solid #ddd',
            borderRadius: 4,
            maxHeight: '14rem',
            overflowY: 'auto',
            background: '#fff',
          }}
        >
          {isSearching && results.length === 0 ? (
            <li
              data-testid="purchase-create-supplier-results-loading"
              style={{ padding: '0.5rem 0.75rem', color: '#777' }}
            >
              Searching…
            </li>
          ) : null}
          {!isSearching && results.length === 0 ? (
            <li
              data-testid="purchase-create-supplier-results-empty"
              style={{ padding: '0.5rem 0.75rem', color: '#777' }}
            >
              No matching suppliers.
            </li>
          ) : null}
          {results.map((s) => (
            <li key={s.id} role="option" aria-selected="false">
              <button
                type="button"
                data-testid={`purchase-create-supplier-result-${s.id}`}
                onClick={() => {
                  onSelect(s);
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
                <strong>{s.name}</strong>
                {s.phone !== null ? (
                  <span style={{ color: '#777', marginLeft: '0.5rem' }}>
                    {s.phone}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface SelectedSupplierCardProps {
  readonly supplier: SupplierDTO;
  readonly onClear: () => void;
}

function SelectedSupplierCard({
  supplier,
  onClear,
}: SelectedSupplierCardProps): ReactElement {
  return (
    <div
      data-testid="purchase-create-supplier-selected"
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
        <strong data-testid="purchase-create-supplier-selected-name">
          {supplier.name}
        </strong>
        {supplier.phone !== null ? (
          <div style={{ color: '#555', fontSize: '0.875rem' }}>{supplier.phone}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClear}
        data-testid="purchase-create-supplier-clear"
        style={{ padding: '0.25rem 0.5rem' }}
      >
        Change
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item line row
// ---------------------------------------------------------------------------

interface PurchaseLineRowProps {
  readonly index: number;
  readonly line: LineState;
  readonly onProductChange: (product: ProductDTO | null) => void;
  readonly onQuantityChange: (next: string) => void;
  readonly onUnitBuyPriceChange: (next: string) => void;
  readonly onRemove: () => void;
  /** When the server returned `VALIDATION { field: 'items[N].<key>' }`
   *  for THIS line, this is the `<key>`. `null` otherwise. */
  readonly validationField: string | null;
  readonly validationMessage: string | null;
}

function LineTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="purchase-create-lines-header"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 6rem 8rem 8rem 4rem',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        fontWeight: 600,
        background: '#f7f7f7',
        borderBottom: '1px solid #ddd',
      }}
    >
      <span>Product</span>
      <span style={{ textAlign: 'right' }}>Quantity</span>
      <span style={{ textAlign: 'right' }}>Unit buy price</span>
      <span style={{ textAlign: 'right' }}>Line total</span>
      <span></span>
    </div>
  );
}

function PurchaseLineRow({
  index,
  line,
  onProductChange,
  onQuantityChange,
  onUnitBuyPriceChange,
  onRemove,
  validationField,
  validationMessage,
}: PurchaseLineRowProps): ReactElement {
  const api = useApi();

  // ----- Product typeahead state (local to this line) -------------------
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<readonly ProductDTO[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    if (query === debouncedQuery) return undefined;
    const handle = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [query, debouncedQuery]);

  useEffect(() => {
    if (line.product !== null) return undefined;
    const trimmed = debouncedQuery.trim();
    if (trimmed.length === 0) {
      setResults([]);
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
        setResults(result.value.rows);
      } else {
        setResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, debouncedQuery, line.product]);

  const handleSelect = (p: ProductDTO): void => {
    onProductChange(p);
    setQuery('');
    setDebouncedQuery('');
    setResults([]);
  };

  const handleClearProduct = (): void => {
    onProductChange(null);
  };

  const showResults = query.trim().length > 0;

  const quantityInvalid =
    validationField === 'quantity' || !isQuantityValid(line.quantity);
  const priceInvalid =
    validationField === 'unitBuyPrice' || !isUnitBuyPriceValid(line.unitBuyPrice);
  const productInvalid =
    validationField === 'productId' && line.product === null;

  return (
    <div
      role="row"
      data-testid={`purchase-create-line-${String(index)}`}
      data-line-index={index}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 6rem 8rem 8rem 4rem',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        borderBottom: '1px solid #eee',
        alignItems: 'start',
      }}
    >
      {/* Product picker */}
      <div>
        {line.product === null ? (
          <div>
            <input
              data-testid={`purchase-create-line-${String(index)}-product-search`}
              type="search"
              autoComplete="off"
              placeholder="Search by name or SKU"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              aria-invalid={productInvalid || undefined}
              style={{
                width: '100%',
                padding: '0.375rem',
                boxSizing: 'border-box',
                borderColor: productInvalid ? '#c33' : undefined,
              }}
            />
            {showResults ? (
              <ul
                role="listbox"
                aria-label="Product search results"
                data-testid={`purchase-create-line-${String(index)}-product-results`}
                style={{
                  listStyle: 'none',
                  margin: '0.25rem 0 0',
                  padding: 0,
                  border: '1px solid #ddd',
                  borderRadius: 4,
                  maxHeight: '12rem',
                  overflowY: 'auto',
                  background: '#fff',
                }}
              >
                {isSearching && results.length === 0 ? (
                  <li style={{ padding: '0.375rem 0.5rem', color: '#777' }}>
                    Searching…
                  </li>
                ) : null}
                {!isSearching && results.length === 0 ? (
                  <li style={{ padding: '0.375rem 0.5rem', color: '#777' }}>
                    No matching products.
                  </li>
                ) : null}
                {results.map((p) => (
                  <li key={p.id} role="option" aria-selected="false">
                    <button
                      type="button"
                      data-testid={`purchase-create-line-${String(index)}-product-result-${p.id}`}
                      onClick={() => {
                        handleSelect(p);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '0.375rem 0.5rem',
                        background: 'transparent',
                        border: 'none',
                        borderBottom: '1px solid #eee',
                        cursor: 'pointer',
                      }}
                    >
                      <strong>{p.name}</strong>
                      <span style={{ color: '#777', marginLeft: '0.375rem' }}>
                        {p.sku}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {productInvalid && validationMessage !== null ? (
              <FieldError
                id={`purchase-create-line-${String(index)}-product-error`}
                testId={`purchase-create-line-${String(index)}-product-error`}
              >
                {validationMessage}
              </FieldError>
            ) : null}
          </div>
        ) : (
          <div
            data-testid={`purchase-create-line-${String(index)}-product-selected`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.5rem',
              padding: '0.375rem 0.5rem',
              border: '1px solid #cde',
              background: '#f3f8ff',
              borderRadius: 4,
            }}
          >
            <div>
              <strong>{line.product.name}</strong>
              <span style={{ color: '#777', marginLeft: '0.375rem' }}>
                {line.product.sku}
              </span>
            </div>
            <button
              type="button"
              onClick={handleClearProduct}
              data-testid={`purchase-create-line-${String(index)}-product-clear`}
              style={{ padding: '0.125rem 0.5rem' }}
            >
              Change
            </button>
          </div>
        )}
      </div>

      {/* Quantity */}
      <div>
        <input
          data-testid={`purchase-create-line-${String(index)}-quantity`}
          type="text"
          inputMode="numeric"
          value={line.quantity}
          onChange={(e) => {
            onQuantityChange(e.target.value);
          }}
          aria-invalid={
            validationField === 'quantity' || (line.quantity !== '' && !isQuantityValid(line.quantity))
              ? true
              : undefined
          }
          style={{
            width: '100%',
            padding: '0.375rem',
            boxSizing: 'border-box',
            textAlign: 'right',
            borderColor:
              validationField === 'quantity' ||
              (line.quantity !== '' && !isQuantityValid(line.quantity))
                ? '#c33'
                : undefined,
          }}
        />
        {validationField === 'quantity' && validationMessage !== null ? (
          <FieldError
            id={`purchase-create-line-${String(index)}-quantity-error`}
            testId={`purchase-create-line-${String(index)}-quantity-error`}
          >
            {validationMessage}
          </FieldError>
        ) : null}
      </div>

      {/* Unit buy price */}
      <div>
        <input
          data-testid={`purchase-create-line-${String(index)}-unit-buy-price`}
          type="text"
          inputMode="decimal"
          value={line.unitBuyPrice}
          onChange={(e) => {
            onUnitBuyPriceChange(e.target.value);
          }}
          aria-invalid={priceInvalid && line.unitBuyPrice !== '' ? true : undefined}
          style={{
            width: '100%',
            padding: '0.375rem',
            boxSizing: 'border-box',
            textAlign: 'right',
            borderColor:
              priceInvalid && line.unitBuyPrice !== '' ? '#c33' : undefined,
          }}
        />
        {validationField === 'unitBuyPrice' && validationMessage !== null ? (
          <FieldError
            id={`purchase-create-line-${String(index)}-unit-buy-price-error`}
            testId={`purchase-create-line-${String(index)}-unit-buy-price-error`}
          >
            {validationMessage}
          </FieldError>
        ) : null}
      </div>

      {/* Line total (read-only) */}
      <div
        data-testid={`purchase-create-line-${String(index)}-line-total`}
        style={{
          padding: '0.375rem',
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
          color: quantityInvalid || priceInvalid ? '#999' : '#000',
        }}
      >
        {computeLineTotal(line)}
      </div>

      {/* Remove */}
      <div style={{ textAlign: 'right' }}>
        <button
          type="button"
          onClick={onRemove}
          data-testid={`purchase-create-line-${String(index)}-remove`}
          aria-label={`Remove line ${String(index + 1)}`}
          style={{ padding: '0.25rem 0.5rem' }}
        >
          ×
        </button>
      </div>
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
