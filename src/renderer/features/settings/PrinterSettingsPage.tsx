/**
 * Printer settings page (Phase 8, task 8.6).
 *
 * Admin-only entry point for configuring the ESC/POS printer
 * (`Setting('printer.escpos')` — `{ kind, target }`) and exercising
 * the live printer chain via `printer:test`.
 *
 * Surface:
 *
 *   - On mount the page calls `settings:get { key: 'printer.escpos' }`
 *     and renders a loading state until the response settles. A
 *     missing row (`Ok({ value: null })`) seeds the form with empty
 *     defaults; a malformed value (`Err('DB_INTEGRITY')`) seeds the
 *     form with empty defaults and surfaces the envelope inline so
 *     the operator can correct it by saving fresh values.
 *
 *   - `<select>` for `kind` with three options: `usb`, `serial`,
 *     `network`. Each choice updates the helper text under the
 *     `target` input so the operator knows what shape to type
 *     (vendor:product id like `04b8:0202` for USB, COM port for
 *     serial, host:port for network).
 *
 *   - `<input>` for `target`. Free-form string forwarded verbatim to
 *     the ESC/POS adapter — the adapter does not validate target
 *     format past the discriminator (see `escpos-adapter.ts` >
 *     `buildInterfaceUri`).
 *
 *   - "Save" calls `settings:set { key: 'printer.escpos',
 *     value: { kind, target } }`. On `Ok` the page renders a success
 *     indicator; on `Err` the envelope is rendered inline so the
 *     operator can react.
 *
 *   - "Test print" calls `printer:test`. On `Ok` the page renders an
 *     inline indicator naming which adapter handled the print
 *     (`'escpos' | 'html' | 'pdf'`) and, when present, the saved
 *     output path (PDF adapter). On `Err` the envelope is rendered
 *     inline; the operator can read the failure reason and adjust
 *     the configuration.
 *
 * Role gating (Req 8.2): only the `Admin` role reaches the form.
 * Cashiers — and unauthenticated renderers — see a permission-denied
 * surface instead. Defence-in-depth: the IPC matrix already denies
 * `settings:set` and `printer:test` for cashiers (writes an
 * `rbac.deny` audit row, Req 8.4), but rendering the form for a role
 * that cannot save it would be a confusing UX.
 *
 * The printer settings setting key is the same one the ESC/POS
 * adapter reads on every print (`'printer.escpos'`), so changes
 * persisted from this page take effect on the next sale without a
 * main-process restart.
 *
 * Validates: Requirements 4.7, 8.2.
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

import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Setting key under which the printer config is persisted. Matches
 * `escpos-adapter.ts#ESC_POS_SETTING_KEY` so a saved value here is
 * the exact value the ESC/POS adapter reads on every receipt print.
 */
const PRINTER_ESCPOS_SETTING_KEY = 'printer.escpos';

/** Discriminator union for the `kind` select. Matches `EscPosKind`. */
type PrinterKind = 'usb' | 'serial' | 'network';

const PRINTER_KIND_OPTIONS: readonly PrinterKind[] = ['usb', 'serial', 'network'];

/**
 * Helper text rendered under the `target` input, scoped per `kind`.
 * Mirrors the shapes accepted by `escpos-adapter.ts#buildInterfaceUri`:
 *
 *   - USB:     vendor:product id (cross-platform) or platform device
 *              path; the operator types whatever
 *              `node-thermal-printer` will accept on their host.
 *   - Serial:  COM port (`COM3`) or POSIX path (`/dev/ttyS0`).
 *   - Network: `host:port` — the adapter prepends `tcp://`.
 */
const TARGET_HELPER_TEXT: Readonly<Record<PrinterKind, string>> = {
  usb: 'Vendor:product id (e.g. 04b8:0202) or device path / printer name.',
  serial: 'Serial port path (e.g. COM3 on Windows, /dev/ttyS0 on Linux).',
  network: 'Host and port for a network printer (e.g. 192.168.1.50:9100).',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Wire shape persisted under the `printer.escpos` setting key. Mirrors
 * `escpos-adapter.ts#EscPosConfig` exactly.
 */
interface PrinterEscPosConfig {
  readonly kind: PrinterKind;
  readonly target: string;
}

/** Form state — same shape as the wire value with no extra fields. */
interface FormState {
  readonly kind: PrinterKind;
  readonly target: string;
}

const BLANK_STATE: FormState = { kind: 'usb', target: '' };

/**
 * Successful test-print response surfaced inline. Mirrors the
 * `printer:test` channel response shape.
 */
interface TestPrintNotice {
  readonly adapter: 'escpos' | 'html' | 'pdf';
  readonly output?: string;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Narrow an unknown setting value into a `PrinterEscPosConfig`. The
 * seed (Phase 1 task 1.4) initializes the row to `{ kind: 'usb',
 * target: '' }`, so the row exists with the right shape from first
 * launch; this guard accommodates future-shape drift defensively.
 */
function isPrinterEscPosConfig(value: unknown): value is PrinterEscPosConfig {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.kind !== 'usb' && obj.kind !== 'serial' && obj.kind !== 'network') {
    return false;
  }
  if (typeof obj.target !== 'string') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

/**
 * Public entry point. Splits the role gate from the form body so the
 * form can use hooks without violating React's hooks-order invariant
 * across the gated branch.
 */
export function PrinterSettingsPage(): ReactElement {
  const { session } = useAuth();

  if (session?.role !== 'Admin') {
    return <PermissionDenied />;
  }

  return <PrinterSettingsPageInner />;
}

// ---------------------------------------------------------------------------
// Permission-denied fallback
// ---------------------------------------------------------------------------

function PermissionDenied(): ReactElement {
  return (
    <main
      role="alert"
      data-testid="printer-settings-permission-denied"
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
        You do not have permission to view this page. Printer configuration is
        restricted to the Admin role.
      </p>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Form body
// ---------------------------------------------------------------------------

function PrinterSettingsPageInner(): ReactElement {
  const api = useApi();
  const idPrefix = useId();

  // ----- Load state ------------------------------------------------------
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<ErrorEnvelope | null>(null);
  const [state, setState] = useState<FormState>(BLANK_STATE);

  // ----- Save state ------------------------------------------------------
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<ErrorEnvelope | null>(null);
  const [savedNotice, setSavedNotice] = useState<boolean>(false);

  // ----- Test-print state ------------------------------------------------
  const [isTestPrinting, setIsTestPrinting] = useState(false);
  const [testPrintError, setTestPrintError] = useState<ErrorEnvelope | null>(null);
  const [testPrintNotice, setTestPrintNotice] = useState<TestPrintNotice | null>(null);

  // ----- Initial load ----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    void (async () => {
      const result = await api['settings:get']({ key: PRINTER_ESCPOS_SETTING_KEY });
      if (cancelled) return;

      setIsLoading(false);
      if (!result.ok) {
        setLoadError(result.error);
        setState(BLANK_STATE);
        return;
      }

      const value = result.value.value;
      if (value === null || value === undefined) {
        setState(BLANK_STATE);
        return;
      }
      if (isPrinterEscPosConfig(value)) {
        setState({ kind: value.kind, target: value.target });
        return;
      }
      // Malformed shape — fall back to defaults. Surfacing this as a
      // load error preserves the operator's awareness that the row
      // needs a fresh save.
      setLoadError({
        code: 'DB_INTEGRITY',
        message: 'Stored printer configuration has an unexpected shape.',
        details: { reason: 'unexpected_shape' },
      });
      setState(BLANK_STATE);
    })();

    return () => {
      cancelled = true;
    };
  }, [api]);

  // ----- Field handlers --------------------------------------------------
  const setKind = useCallback((next: PrinterKind): void => {
    setState((prev) => ({ ...prev, kind: next }));
    setSaveError(null);
    setSavedNotice(false);
  }, []);

  const setTarget = useCallback((next: string): void => {
    setState((prev) => ({ ...prev, target: next }));
    setSaveError(null);
    setSavedNotice(false);
  }, []);

  // ----- Submit (Save) ---------------------------------------------------
  const handleSave = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (isSaving) return;

      const payload: PrinterEscPosConfig = {
        kind: state.kind,
        target: state.target.trim(),
      };

      setIsSaving(true);
      setSaveError(null);
      setSavedNotice(false);
      // Clear the test-print indicator on save so the operator does
      // not conflate a stale test print with the freshly-saved
      // configuration.
      setTestPrintError(null);
      setTestPrintNotice(null);

      void (async () => {
        try {
          const result = await api['settings:set']({
            key: PRINTER_ESCPOS_SETTING_KEY,
            value: payload,
          });
          if (result.ok) {
            setSavedNotice(true);
            return;
          }
          setSaveError(result.error);
        } finally {
          setIsSaving(false);
        }
      })();
    },
    [api, isSaving, state.kind, state.target],
  );

  // ----- Test print ------------------------------------------------------
  const handleTestPrint = useCallback((): void => {
    if (isTestPrinting) return;

    setIsTestPrinting(true);
    setTestPrintError(null);
    setTestPrintNotice(null);

    void (async () => {
      try {
        const result = await api['printer:test']();
        if (result.ok) {
          const notice: TestPrintNotice =
            result.value.output !== undefined
              ? { adapter: result.value.adapter, output: result.value.output }
              : { adapter: result.value.adapter };
          setTestPrintNotice(notice);
          return;
        }
        setTestPrintError(result.error);
      } finally {
        setIsTestPrinting(false);
      }
    })();
  }, [api, isTestPrinting]);

  // ----- Render ----------------------------------------------------------
  if (isLoading) {
    return (
      <main
        data-testid="printer-settings-loading"
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          maxWidth: '36rem',
          margin: '0 auto',
        }}
      >
        <h1 style={{ marginBottom: '0.5rem' }}>Printer settings</h1>
        <p style={{ color: '#555' }}>Loading current configuration…</p>
      </main>
    );
  }

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '36rem',
        margin: '0 auto',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>Printer settings</h1>
      <p style={{ marginBottom: '1.5rem', color: '#555' }}>
        Configure the ESC/POS receipt printer. Saved values take effect on
        the next sale; use Test print to confirm the printer is reachable
        before relying on it at the till.
      </p>

      {loadError !== null ? (
        <div
          role="alert"
          data-testid="printer-settings-load-error"
          style={{
            marginBottom: '1rem',
            padding: '0.75rem',
            border: '1px solid #c33',
            color: '#c33',
            background: '#fff5f5',
            borderRadius: 4,
          }}
        >
          <strong>{loadError.code}</strong>
          <div>{loadError.message}</div>
        </div>
      ) : null}

      <form onSubmit={handleSave} noValidate>
        {/* Kind ------------------------------------------------------- */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor={`${idPrefix}-kind`}
            style={{ display: 'block', marginBottom: '0.25rem' }}
          >
            Connection type <span aria-hidden="true">*</span>
          </label>
          <select
            id={`${idPrefix}-kind`}
            data-testid="printer-settings-kind"
            value={state.kind}
            onChange={(e) => {
              setKind(e.target.value as PrinterKind);
            }}
            style={{
              width: '100%',
              padding: '0.5rem',
              boxSizing: 'border-box',
            }}
          >
            {PRINTER_KIND_OPTIONS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </div>

        {/* Target ----------------------------------------------------- */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor={`${idPrefix}-target`}
            style={{ display: 'block', marginBottom: '0.25rem' }}
          >
            Target
          </label>
          <input
            id={`${idPrefix}-target`}
            data-testid="printer-settings-target"
            type="text"
            value={state.target}
            onChange={(e) => {
              setTarget(e.target.value);
            }}
            aria-describedby={`${idPrefix}-target-help`}
            style={{
              width: '100%',
              padding: '0.5rem',
              boxSizing: 'border-box',
            }}
          />
          <div
            id={`${idPrefix}-target-help`}
            data-testid="printer-settings-target-help"
            style={{ marginTop: '0.25rem', color: '#555', fontSize: '0.875rem' }}
          >
            {TARGET_HELPER_TEXT[state.kind]}
          </div>
        </div>

        {/* Save error / success */}
        {saveError !== null ? (
          <div
            role="alert"
            data-testid="printer-settings-save-error"
            style={{
              marginBottom: '1rem',
              padding: '0.75rem',
              border: '1px solid #c33',
              color: '#c33',
              background: '#fff5f5',
              borderRadius: 4,
            }}
          >
            <strong>{saveError.code}</strong>
            <div>{saveError.message}</div>
          </div>
        ) : null}

        {savedNotice ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="printer-settings-save-success"
            style={{
              marginBottom: '1rem',
              padding: '0.75rem',
              border: '1px solid #2a8',
              color: '#1a6',
              background: '#f3fff7',
              borderRadius: 4,
            }}
          >
            <strong>Saved</strong>
            <div>Printer configuration updated.</div>
          </div>
        ) : null}

        {/* Buttons ---------------------------------------------------- */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="submit"
            disabled={isSaving}
            data-testid="printer-settings-save"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={isTestPrinting}
            onClick={handleTestPrint}
            data-testid="printer-settings-test"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            {isTestPrinting ? 'Printing…' : 'Test print'}
          </button>
        </div>
      </form>

      {/* Test-print error / success */}
      {testPrintError !== null ? (
        <div
          role="alert"
          data-testid="printer-settings-test-error"
          style={{
            marginTop: '1rem',
            padding: '0.75rem',
            border: '1px solid #c33',
            color: '#c33',
            background: '#fff5f5',
            borderRadius: 4,
          }}
        >
          <strong>Test print failed ({testPrintError.code})</strong>
          <div>{testPrintError.message}</div>
        </div>
      ) : null}

      {testPrintNotice !== null ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="printer-settings-test-success"
          style={{
            marginTop: '1rem',
            padding: '0.75rem',
            border: '1px solid #2a8',
            color: '#1a6',
            background: '#f3fff7',
            borderRadius: 4,
          }}
        >
          <strong>Test print sent</strong>
          <div>
            Handled by adapter: <code>{testPrintNotice.adapter}</code>
            {testPrintNotice.output !== undefined ? (
              <>
                {' '}— saved to <code>{testPrintNotice.output}</code>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
