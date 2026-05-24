/**
 * Product create / edit form (task 4.4, Phase 4).
 *
 * One form, two modes:
 *
 *   - Create mode (`product` prop omitted): all fields start blank,
 *     submit calls `products:upsert` without an `id`.
 *   - Edit mode (`product` prop provided by the list page row click):
 *     fields are seeded from the DTO, submit calls `products:upsert`
 *     with the existing `id`.
 *
 * The list page hands the full `ProductDTO` directly so the form does
 * not need a `products:get` channel — the IPC contract only exposes
 * `products:list`, `products:count`, and `products:upsert` today (Phase
 * 4 task 4.2). When a future change adds `products:get`, this component
 * can grow an `id`-only entry path without touching the submit logic.
 *
 * Validation strategy mirrors the LoginPage / SetupPage approach
 * already used in the codebase:
 *
 *   - Cheap client-side checks (required fields, non-negative prices)
 *     gate the submit button. The button stays disabled until the form
 *     is internally consistent.
 *   - All cross-record errors come from the server envelope:
 *       * `UNIQUE_VIOLATION` — service writes `{ field: 'sku' | 'barcode' }`.
 *       * `VALIDATION`       — service writes `{ field: <name> }`.
 *       * Anything else      — generic banner with code + message.
 *
 * Inline server errors are surfaced next to the offending input with
 * `aria-describedby` so screen-reader users hear them; the generic
 * banner uses `role="alert"`.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 8.3.
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

import type { CategoryDTO, ProductDTO, ProductInput } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ProductFormPageProps {
  /**
   * When provided, the form opens in edit mode pre-populated from the
   * DTO. When omitted, the form opens in create mode with blank fields.
   */
  readonly product?: ProductDTO;
  /**
   * Optional category list. Passing it from the list page avoids a
   * second `categories:list` round trip; if omitted, the form fetches
   * its own copy on mount. (The dropdown is required by the form, so
   * one of the two paths must populate it.)
   */
  readonly categories?: readonly CategoryDTO[];
  /**
   * Called when the user successfully submits, or clicks Cancel.
   * Receives the resulting `ProductDTO` on success so the parent can
   * trigger any post-submit work; receives `undefined` on cancel.
   */
  readonly onClose: (saved?: ProductDTO) => void;
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

/**
 * Each field is held as its raw string input. Numeric coercion happens
 * once at submit time so the user can type `12.` without the value
 * snapping back to `12` mid-edit.
 */
interface FormState {
  sku: string;
  name: string;
  categoryId: string;
  barcode: string;
  buyPrice: string;
  sellPrice: string;
  taxRate: string;
  warrantyMonths: string;
  reorderLevel: string;
}

function blankState(): FormState {
  return {
    sku: '',
    name: '',
    categoryId: '',
    barcode: '',
    buyPrice: '0',
    sellPrice: '0',
    taxRate: '0',
    warrantyMonths: '0',
    reorderLevel: '0',
  };
}

function stateFromDTO(p: ProductDTO): FormState {
  return {
    sku: p.sku,
    name: p.name,
    categoryId: p.categoryId,
    barcode: p.barcode ?? '',
    buyPrice: p.buyPrice,
    sellPrice: p.sellPrice,
    taxRate: p.taxRate,
    warrantyMonths: String(p.warrantyMonths),
    reorderLevel: String(p.reorderLevel),
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface ClientErrors {
  readonly sku?: string;
  readonly name?: string;
  readonly categoryId?: string;
  readonly buyPrice?: string;
  readonly sellPrice?: string;
  readonly taxRate?: string;
  readonly warrantyMonths?: string;
  readonly reorderLevel?: string;
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;
const INT_RE = /^\d+$/;

/**
 * Run the client-side guardrails. Server still validates everything —
 * this is just to gate the submit button and surface obvious typos
 * inline before round-tripping.
 */
function validate(state: FormState): ClientErrors {
  const errors: { -readonly [K in keyof ClientErrors]?: string } = {};
  if (state.sku.trim().length === 0) errors.sku = 'SKU is required.';
  if (state.name.trim().length === 0) errors.name = 'Name is required.';
  if (state.categoryId.length === 0) errors.categoryId = 'Category is required.';

  if (!DECIMAL_RE.test(state.buyPrice.trim())) {
    errors.buyPrice = 'Buy price must be a non-negative number.';
  }
  if (!DECIMAL_RE.test(state.sellPrice.trim())) {
    errors.sellPrice = 'Sell price must be a non-negative number.';
  }
  if (!DECIMAL_RE.test(state.taxRate.trim())) {
    errors.taxRate = 'Tax rate must be a non-negative number.';
  }
  if (!INT_RE.test(state.warrantyMonths.trim())) {
    errors.warrantyMonths = 'Warranty months must be a non-negative integer.';
  }
  if (!INT_RE.test(state.reorderLevel.trim())) {
    errors.reorderLevel = 'Reorder level must be a non-negative integer.';
  }
  return errors;
}

function hasErrors(errors: ClientErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * Build a `ProductInput` from validated form state. Caller has already
 * confirmed the strings parse cleanly, so the coercions are safe.
 */
function buildInput(state: FormState, existingId: string | undefined): ProductInput {
  const trimmedBarcode = state.barcode.trim();
  const base: ProductInput = {
    sku: state.sku.trim(),
    name: state.name.trim(),
    categoryId: state.categoryId,
    buyPrice: state.buyPrice.trim(),
    sellPrice: state.sellPrice.trim(),
    taxRate: state.taxRate.trim(),
    warrantyMonths: Number.parseInt(state.warrantyMonths.trim(), 10),
    reorderLevel: Number.parseInt(state.reorderLevel.trim(), 10),
    barcode: trimmedBarcode === '' ? null : trimmedBarcode,
  };
  if (existingId !== undefined) {
    return { ...base, id: existingId };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Server-error reading
// ---------------------------------------------------------------------------

/**
 * Pull the offending field name out of an error envelope. The product
 * service (`src/main/services/product.service.ts`) writes
 * `{ field: 'sku' | 'barcode' | ... }` for both `VALIDATION` and
 * `UNIQUE_VIOLATION` envelopes, which is the contract the renderer
 * relies on here.
 */
function readErrorField(error: ErrorEnvelope): string | null {
  const details = error.details;
  if (details === undefined) return null;
  const field = (details as { field?: unknown }).field;
  if (typeof field !== 'string' || field.length === 0) return null;
  return field;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProductFormPage({
  product,
  categories,
  onClose,
}: ProductFormPageProps): ReactElement {
  const api = useApi();
  const idPrefix = useId();
  const isEdit = product !== undefined;

  const [state, setState] = useState<FormState>(() =>
    product !== undefined ? stateFromDTO(product) : blankState(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<ErrorEnvelope | null>(null);

  // ----- Categories source ------------------------------------------------
  // Either supplied by the parent (cheap path) or fetched once here.
  // The fetch runs exactly once per mount; the cancellation flag
  // prevents a late response from clobbering state on an unmounted
  // component.
  const [localCategories, setLocalCategories] = useState<readonly CategoryDTO[]>(
    categories ?? [],
  );
  const needsCategoryFetch = categories === undefined;
  useEffect(() => {
    if (!needsCategoryFetch) return undefined;
    let cancelled = false;
    void (async () => {
      const result = await api['categories:list']();
      if (cancelled) return;
      if (result.ok) {
        setLocalCategories(result.value.rows);
      }
      // On error: leave the dropdown empty. The toast wrapper inside
      // useApi() already surfaces INTERNAL / UNAUTHENTICATED envelopes;
      // the form's category VALIDATION will fire on submit.
    })();
    return () => {
      cancelled = true;
    };
  }, [api, needsCategoryFetch]);

  // ----- Field updaters ----------------------------------------------------
  const setField = useCallback(<K extends keyof FormState>(key: K, value: string): void => {
    setState((prev) => ({ ...prev, [key]: value }));
    // Clear the server error for the affected field as soon as the user
    // edits it — the next submit will re-issue the request and either
    // confirm the fix or surface the error again.
    setServerError(null);
  }, []);

  // ----- Submit ------------------------------------------------------------
  const clientErrors = validate(state);
  const canSubmit = !submitting && !hasErrors(clientErrors);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!canSubmit) return;

      const input = buildInput(state, product?.id);
      setSubmitting(true);
      setServerError(null);

      void (async () => {
        try {
          const result = await api['products:upsert'](input);
          if (result.ok) {
            onClose(result.value);
            return;
          }
          setServerError(result.error);
        } finally {
          setSubmitting(false);
        }
      })();
    },
    [api, canSubmit, onClose, product?.id, state],
  );

  const handleCancel = useCallback((): void => {
    onClose();
  }, [onClose]);

  // ----- Server-side per-field errors -------------------------------------
  // For VALIDATION and UNIQUE_VIOLATION envelopes the service tells us
  // which field tripped. Anything else lives in the page-level banner.
  const serverField =
    serverError !== null &&
    (serverError.code === 'VALIDATION' || serverError.code === 'UNIQUE_VIOLATION')
      ? readErrorField(serverError)
      : null;

  const inlineMessage = (key: keyof FormState): string | undefined => {
    const clientMsg = clientErrors[key as keyof ClientErrors];
    if (clientMsg !== undefined) return clientMsg;
    if (serverField === key && serverError !== null) {
      if (serverError.code === 'UNIQUE_VIOLATION') {
        return `This ${key} is already in use.`;
      }
      return serverError.message;
    }
    return undefined;
  };

  // ---- Render ------------------------------------------------------------
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '40rem',
        margin: '0 auto',
      }}
    >
      <h1 style={{ marginBottom: '1rem' }}>
        {isEdit ? 'Edit product' : 'New product'}
      </h1>

      <form onSubmit={handleSubmit} noValidate>
        <Field
          id={`${idPrefix}-sku`}
          label="SKU"
          required
          value={state.sku}
          onChange={(v) => {
            setField('sku', v);
          }}
          error={inlineMessage('sku')}
        />

        <Field
          id={`${idPrefix}-name`}
          label="Name"
          required
          value={state.name}
          onChange={(v) => {
            setField('name', v);
          }}
          error={inlineMessage('name')}
        />

        <SelectField
          id={`${idPrefix}-categoryId`}
          label="Category"
          required
          value={state.categoryId}
          onChange={(v) => {
            setField('categoryId', v);
          }}
          options={localCategories}
          error={inlineMessage('categoryId')}
        />

        <Field
          id={`${idPrefix}-barcode`}
          label="Barcode (optional)"
          value={state.barcode}
          onChange={(v) => {
            setField('barcode', v);
          }}
          error={
            serverField === 'barcode' && serverError !== null
              ? serverError.code === 'UNIQUE_VIOLATION'
                ? 'This barcode is already in use.'
                : serverError.message
              : undefined
          }
        />

        <Field
          id={`${idPrefix}-buyPrice`}
          label="Buy price"
          required
          inputMode="decimal"
          value={state.buyPrice}
          onChange={(v) => {
            setField('buyPrice', v);
          }}
          error={inlineMessage('buyPrice')}
        />

        <Field
          id={`${idPrefix}-sellPrice`}
          label="Sell price"
          required
          inputMode="decimal"
          value={state.sellPrice}
          onChange={(v) => {
            setField('sellPrice', v);
          }}
          error={inlineMessage('sellPrice')}
        />

        <Field
          id={`${idPrefix}-taxRate`}
          label="Tax rate"
          required
          inputMode="decimal"
          value={state.taxRate}
          onChange={(v) => {
            setField('taxRate', v);
          }}
          error={inlineMessage('taxRate')}
        />

        <Field
          id={`${idPrefix}-warrantyMonths`}
          label="Warranty (months)"
          required
          inputMode="numeric"
          value={state.warrantyMonths}
          onChange={(v) => {
            setField('warrantyMonths', v);
          }}
          error={inlineMessage('warrantyMonths')}
        />

        <Field
          id={`${idPrefix}-reorderLevel`}
          label="Reorder level"
          required
          inputMode="numeric"
          value={state.reorderLevel}
          onChange={(v) => {
            setField('reorderLevel', v);
          }}
          error={inlineMessage('reorderLevel')}
        />

        {serverError !== null && serverField === null ? (
          <div
            role="alert"
            data-testid="product-form-banner"
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
            <div>{serverError.message}</div>
          </div>
        ) : null}

        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem' }}>
          <button
            type="submit"
            disabled={!canSubmit}
            data-testid="product-form-submit"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create product'}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={submitting}
            data-testid="product-form-cancel"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            Cancel
          </button>
        </div>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly required?: boolean;
  readonly inputMode?: 'decimal' | 'numeric';
  /**
   * Inline error message. Pass `undefined` to render no error. Typed as
   * `string | undefined` (not optional) so callers can forward the
   * result of a validation lookup without conditional spreads under
   * `exactOptionalPropertyTypes`.
   */
  readonly error: string | undefined;
}

function Field(props: FieldProps): ReactElement {
  const errorId = props.error !== undefined ? `${props.id}-error` : undefined;
  return (
    <div style={{ marginBottom: '0.875rem' }}>
      <label htmlFor={props.id} style={{ display: 'block', marginBottom: '0.25rem' }}>
        {props.label}
        {props.required === true ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={props.id}
        type="text"
        required={props.required === true}
        inputMode={props.inputMode}
        aria-invalid={props.error !== undefined}
        aria-describedby={errorId}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        style={{
          width: '100%',
          padding: '0.5rem',
          boxSizing: 'border-box',
          borderColor: props.error !== undefined ? '#c33' : undefined,
        }}
      />
      {props.error !== undefined ? (
        <div
          id={errorId}
          role="alert"
          data-testid={`${props.id}-error`}
          style={{ marginTop: '0.25rem', color: '#c33', fontSize: '0.875rem' }}
        >
          {props.error}
        </div>
      ) : null}
    </div>
  );
}

interface SelectFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly options: readonly CategoryDTO[];
  readonly required?: boolean;
  /** Same shape as {@link FieldProps.error}. */
  readonly error: string | undefined;
}

function SelectField(props: SelectFieldProps): ReactElement {
  const errorId = props.error !== undefined ? `${props.id}-error` : undefined;
  return (
    <div style={{ marginBottom: '0.875rem' }}>
      <label htmlFor={props.id} style={{ display: 'block', marginBottom: '0.25rem' }}>
        {props.label}
        {props.required === true ? <span aria-hidden="true"> *</span> : null}
      </label>
      <select
        id={props.id}
        required={props.required === true}
        aria-invalid={props.error !== undefined}
        aria-describedby={errorId}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
      >
        <option value="">Select a category…</option>
        {props.options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {props.error !== undefined ? (
        <div
          id={errorId}
          role="alert"
          data-testid={`${props.id}-error`}
          style={{ marginTop: '0.25rem', color: '#c33', fontSize: '0.875rem' }}
        >
          {props.error}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// (no more internal helpers below)
// ---------------------------------------------------------------------------
