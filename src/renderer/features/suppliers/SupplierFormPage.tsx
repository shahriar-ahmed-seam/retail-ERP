/**
 * Supplier create / edit form (task 6.1, Phase 6).
 *
 * One form, two modes:
 *
 *   - Create mode (`supplier` prop omitted): all fields start blank,
 *     submit calls `suppliers:upsert` without an `id`.
 *   - Edit mode (`supplier` prop provided): fields seeded from the
 *     DTO, submit calls `suppliers:upsert` with the existing `id`.
 *
 * Validation strategy mirrors the products form:
 *   - Cheap client-side checks (required name, length bounds) gate
 *     the submit button. The button stays disabled until the form
 *     is internally consistent.
 *   - Per-field server errors come from the envelope:
 *       * `VALIDATION { field }` — inline next to the offending input.
 *       * `FK_VIOLATION { reason: 'not_found' }` — banner (the row
 *         vanished while the user was editing).
 *       * Anything else — generic banner with code + message.
 *
 * The Supplier model has no UNIQUE constraints on user-editable text
 * columns, so `UNIQUE_VIOLATION` is not part of this form's surface.
 *
 * Validates: Requirements 6.1, 6.2, 8.2.
 */

import {
  useCallback,
  useId,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';

import { useApi } from '@renderer/lib/api';

import type { SupplierDTO, SupplierInput } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SupplierFormPageProps {
  /** When provided the form opens in edit mode, pre-populated from the DTO. */
  readonly supplier?: SupplierDTO;
  /**
   * Called when the user successfully submits, or clicks Cancel.
   * Receives the resulting `SupplierDTO` on success; receives
   * `undefined` on cancel.
   */
  readonly onClose: (saved?: SupplierDTO) => void;
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

/** Bounds mirror `supplier.service.ts` so the renderer can give early
 *  feedback before submitting. */
const NAME_MIN = 1;
const NAME_MAX = 100;
const PHONE_MAX = 30;
const ADDRESS_MAX = 200;

interface FormState {
  name: string;
  phone: string;
  address: string;
}

function blankState(): FormState {
  return { name: '', phone: '', address: '' };
}

function stateFromDTO(s: SupplierDTO): FormState {
  return {
    name: s.name,
    phone: s.phone ?? '',
    address: s.address ?? '',
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ClientErrors {
  readonly name?: string;
  readonly phone?: string;
  readonly address?: string;
}

function validate(state: FormState): ClientErrors {
  const errors: { -readonly [K in keyof ClientErrors]?: string } = {};
  const trimmedName = state.name.trim();
  if (trimmedName.length < NAME_MIN) {
    errors.name = 'Name is required.';
  } else if (trimmedName.length > NAME_MAX) {
    errors.name = `Name must be ${String(NAME_MAX)} characters or fewer.`;
  }
  if (state.phone.trim().length > PHONE_MAX) {
    errors.phone = `Phone must be ${String(PHONE_MAX)} characters or fewer.`;
  }
  if (state.address.trim().length > ADDRESS_MAX) {
    errors.address = `Address must be ${String(ADDRESS_MAX)} characters or fewer.`;
  }
  return errors;
}

function hasErrors(errors: ClientErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Build a `SupplierInput` from validated form state. */
function buildInput(state: FormState, existingId: string | undefined): SupplierInput {
  const trimmedPhone = state.phone.trim();
  const trimmedAddress = state.address.trim();
  const base: SupplierInput = {
    name: state.name.trim(),
    phone: trimmedPhone === '' ? null : trimmedPhone,
    address: trimmedAddress === '' ? null : trimmedAddress,
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
 * Pull the offending field name out of an error envelope. The supplier
 * service writes `{ field: 'name' | 'phone' | 'address' }` for
 * VALIDATION envelopes.
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

export function SupplierFormPage({
  supplier,
  onClose,
}: SupplierFormPageProps): ReactElement {
  const api = useApi();
  const idPrefix = useId();
  const isEdit = supplier !== undefined;

  const [state, setState] = useState<FormState>(() =>
    supplier !== undefined ? stateFromDTO(supplier) : blankState(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<ErrorEnvelope | null>(null);

  const setField = useCallback(<K extends keyof FormState>(key: K, value: string): void => {
    setState((prev) => ({ ...prev, [key]: value }));
    setServerError(null);
  }, []);

  const clientErrors = validate(state);
  const canSubmit = !submitting && !hasErrors(clientErrors);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!canSubmit) return;

      const input = buildInput(state, supplier?.id);
      setSubmitting(true);
      setServerError(null);

      void (async () => {
        try {
          const result = await api['suppliers:upsert'](input);
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
    [api, canSubmit, onClose, state, supplier?.id],
  );

  const handleCancel = useCallback((): void => {
    onClose();
  }, [onClose]);

  // Per-field server-error mapping. VALIDATION targets a specific
  // field; everything else falls through to the page-level banner.
  const serverField =
    serverError !== null && serverError.code === 'VALIDATION'
      ? readErrorField(serverError)
      : null;

  const inlineMessage = (key: keyof FormState): string | undefined => {
    const clientMsg = clientErrors[key];
    if (clientMsg !== undefined) return clientMsg;
    if (serverField === key && serverError !== null) {
      return serverError.message;
    }
    return undefined;
  };

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
        {isEdit ? 'Edit supplier' : 'New supplier'}
      </h1>

      <form onSubmit={handleSubmit} noValidate>
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

        <Field
          id={`${idPrefix}-phone`}
          label="Phone (optional)"
          value={state.phone}
          onChange={(v) => {
            setField('phone', v);
          }}
          error={inlineMessage('phone')}
        />

        <Field
          id={`${idPrefix}-address`}
          label="Address (optional)"
          value={state.address}
          onChange={(v) => {
            setField('address', v);
          }}
          error={inlineMessage('address')}
          multiline
        />

        {serverError !== null && serverField === null ? (
          <div
            role="alert"
            data-testid="supplier-form-banner"
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
              {serverError.code === 'FK_VIOLATION'
                ? 'This supplier no longer exists.'
                : serverError.message}
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem' }}>
          <button
            type="submit"
            disabled={!canSubmit}
            data-testid="supplier-form-submit"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create supplier'}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={submitting}
            data-testid="supplier-form-cancel"
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
// Field
// ---------------------------------------------------------------------------

interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly required?: boolean;
  readonly multiline?: boolean;
  readonly error: string | undefined;
}

function Field(props: FieldProps): ReactElement {
  const errorId = props.error !== undefined ? `${props.id}-error` : undefined;
  const sharedProps = {
    id: props.id,
    'aria-invalid': props.error !== undefined,
    'aria-describedby': errorId,
    required: props.required === true,
    value: props.value,
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      props.onChange(e.target.value);
    },
    style: {
      width: '100%',
      padding: '0.5rem',
      boxSizing: 'border-box' as const,
      borderColor: props.error !== undefined ? '#c33' : undefined,
    },
  };

  return (
    <div style={{ marginBottom: '0.875rem' }}>
      <label htmlFor={props.id} style={{ display: 'block', marginBottom: '0.25rem' }}>
        {props.label}
        {props.required === true ? <span aria-hidden="true"> *</span> : null}
      </label>
      {props.multiline === true ? (
        <textarea {...sharedProps} rows={3} maxLength={ADDRESS_MAX} />
      ) : (
        <input {...sharedProps} type="text" />
      )}
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
