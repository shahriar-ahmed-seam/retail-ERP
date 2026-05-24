/**
 * Shared building blocks for the four report pages (task 10.8).
 *
 * The four report pages share a common surface: a header (title +
 * description), a filter strip, a totals card grid, optional preview
 * tables, and a triplet of export buttons (CSV / PDF / Both). Lifting
 * those bits here keeps every page focused on its own data shape and
 * filter envelope while sharing the same look + behavior across the
 * Reports module.
 *
 * `useReportExport` is the hook every page calls to wire its CSV /
 * PDF / Both buttons through `reports:export`. The hook keeps a
 * single in-flight slot per format so the operator cannot accidentally
 * fire overlapping exports against the same window.
 *
 * Validates: Requirements 9.5, 16.5, 8.2.
 */

import {
  useCallback,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useApi } from '@renderer/lib/api';

import type {
  ReportExportFormat,
  ReportExportRequest,
  ReportExportResponse,
} from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Format a `Date` as the local-timezone `YYYY-MM-DD` string a native
 * `<input type="date">` accepts. `toISOString()` would force UTC and
 * silently shift the picker by a day for operators east of UTC.
 */
export function formatLocalDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${month}-${day}`;
}

/**
 * Format a `Date` as the local-timezone `YYYY-MM` string a native
 * `<input type="month">` accepts.
 */
export function formatLocalMonthInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${month}`;
}

/**
 * Subtract `days` from a date and return the local-timezone
 * `YYYY-MM-DD`. Used by the top-selling page's default range.
 */
export function subtractDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() - days);
  return next;
}

// ---------------------------------------------------------------------------
// ReportHeader
// ---------------------------------------------------------------------------

interface ReportHeaderProps {
  readonly title: string;
  readonly description: string;
}

export function ReportHeader({
  title,
  description,
}: ReportHeaderProps): ReactElement {
  return (
    <header style={{ marginBottom: '1rem' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>{title}</h1>
      <p style={{ marginTop: 0, color: '#555' }}>{description}</p>
    </header>
  );
}

// ---------------------------------------------------------------------------
// ReportMessage — generic info / loading / error surface
// ---------------------------------------------------------------------------

interface ReportMessageProps {
  readonly testId: string;
  readonly title: string;
  readonly body: string;
  readonly tone?: 'info' | 'error';
  readonly role?: 'alert' | 'status' | 'region';
}

export function ReportMessage({
  testId,
  title,
  body,
  tone = 'info',
  role = 'status',
}: ReportMessageProps): ReactElement {
  const colors =
    tone === 'error'
      ? { border: '#c33', color: '#c33', background: '#fff5f5' }
      : { border: '#cde', color: '#345', background: '#f3f8ff' };
  return (
    <div
      role={role}
      data-testid={testId}
      style={{
        padding: '0.75rem',
        marginBottom: '1rem',
        border: `1px solid ${colors.border}`,
        color: colors.color,
        background: colors.background,
        borderRadius: 4,
      }}
    >
      <strong>{title}</strong>
      <div>{body}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TotalsCardGrid
// ---------------------------------------------------------------------------

export interface TotalsCard {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}

interface TotalsCardGridProps {
  readonly testId: string;
  readonly cards: readonly TotalsCard[];
}

export function TotalsCardGrid({
  testId,
  cards,
}: TotalsCardGridProps): ReactElement {
  return (
    <section
      data-testid={testId}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
        gap: '0.75rem',
        marginBottom: '1.5rem',
      }}
    >
      {cards.map((c) => (
        <div
          key={c.label}
          data-testid={c.testId}
          style={{
            padding: '0.75rem 1rem',
            border: '1px solid #ddd',
            borderRadius: 4,
            background: '#fafafa',
          }}
        >
          <div
            style={{
              fontSize: '0.75rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: '#777',
            }}
          >
            {c.label}
          </div>
          <div
            style={{
              fontSize: '1.5rem',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {c.value}
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// useReportExport
// ---------------------------------------------------------------------------

export interface UseReportExportInput {
  readonly reportId: ReportExportRequest['reportId'];
  readonly filter?: ReportExportRequest['filter'];
}

export interface ReportExportSuccessNotice {
  readonly format: ReportExportFormat | 'both';
  readonly response: ReportExportResponse;
}

export interface UseReportExportResult {
  readonly isExporting: boolean;
  /** Format currently in flight, or `null` when idle. */
  readonly inFlight: ReportExportFormat | 'both' | null;
  readonly success: ReportExportSuccessNotice | null;
  readonly error: ErrorEnvelope | null;
  readonly run: (format: ReportExportFormat | 'both') => void;
  readonly reset: () => void;
}

/**
 * Drive the `reports:export` channel for a given `reportId` /
 * `filter` envelope. Caller passes one of `'csv' | 'pdf' | 'both'`;
 * the hook normalizes that into the `request.format` field
 * (`'csv'`, `'pdf'`, or `['csv', 'pdf']` for "both") and forwards.
 *
 * The hook intentionally does NOT pass `paths` — the main process
 * opens `dialog.showSaveDialog` for each output. A user cancellation
 * surfaces as `Err('USER_CANCELED')` and is rendered as a non-
 * destructive notice (the operator pressed Cancel; nothing went
 * wrong).
 */
export function useReportExport(input: UseReportExportInput): UseReportExportResult {
  const api = useApi();
  const [inFlight, setInFlight] = useState<ReportExportFormat | 'both' | null>(null);
  const [success, setSuccess] = useState<ReportExportSuccessNotice | null>(null);
  const [error, setError] = useState<ErrorEnvelope | null>(null);

  const reset = useCallback((): void => {
    setSuccess(null);
    setError(null);
  }, []);

  const run = useCallback(
    (format: ReportExportFormat | 'both'): void => {
      if (inFlight !== null) return;
      const request: ReportExportRequest = {
        reportId: input.reportId,
        format: format === 'both' ? ['csv', 'pdf'] : format,
        ...(input.filter !== undefined ? { filter: input.filter } : {}),
      };
      setInFlight(format);
      setSuccess(null);
      setError(null);
      void (async () => {
        try {
          const result = await api['reports:export'](request);
          if (result.ok) {
            setSuccess({ format, response: result.value });
          } else {
            setError(result.error);
          }
        } finally {
          setInFlight(null);
        }
      })();
    },
    [api, inFlight, input.filter, input.reportId],
  );

  return {
    isExporting: inFlight !== null,
    inFlight,
    success,
    error,
    run,
    reset,
  };
}

// ---------------------------------------------------------------------------
// ExportButtonRow
// ---------------------------------------------------------------------------

interface ExportButtonRowProps {
  readonly testIdPrefix: string;
  readonly state: UseReportExportResult;
  /**
   * When true, all three buttons are disabled (the page is still
   * loading the underlying report or the report is empty). The hook
   * is also disabled internally while a request is in flight.
   */
  readonly disabled?: boolean;
}

export function ExportButtonRow({
  testIdPrefix,
  state,
  disabled = false,
}: ExportButtonRowProps): ReactElement {
  const isAnyDisabled = disabled || state.isExporting;
  const buttonStyle = (active: boolean): React.CSSProperties => ({
    padding: '0.5rem 1rem',
    cursor: active ? 'wait' : isAnyDisabled ? 'not-allowed' : 'pointer',
  });

  return (
    <section aria-label="Export" style={{ marginTop: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid={`${testIdPrefix}-csv`}
          disabled={isAnyDisabled}
          onClick={() => {
            state.run('csv');
          }}
          style={buttonStyle(state.inFlight === 'csv')}
        >
          {state.inFlight === 'csv' ? 'Exporting…' : 'Export CSV'}
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-pdf`}
          disabled={isAnyDisabled}
          onClick={() => {
            state.run('pdf');
          }}
          style={buttonStyle(state.inFlight === 'pdf')}
        >
          {state.inFlight === 'pdf' ? 'Exporting…' : 'Export PDF'}
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-both`}
          disabled={isAnyDisabled}
          onClick={() => {
            state.run('both');
          }}
          style={buttonStyle(state.inFlight === 'both')}
        >
          {state.inFlight === 'both' ? 'Exporting…' : 'Export Both'}
        </button>
      </div>

      {state.success !== null ? (
        <ExportSuccessNotice
          testId={`${testIdPrefix}-success`}
          notice={state.success}
        />
      ) : null}

      {state.error !== null ? (
        <ExportErrorNotice
          testId={`${testIdPrefix}-error`}
          error={state.error}
        />
      ) : null}
    </section>
  );
}

interface ExportSuccessNoticeProps {
  readonly testId: string;
  readonly notice: ReportExportSuccessNotice;
}

function ExportSuccessNotice({
  testId,
  notice,
}: ExportSuccessNoticeProps): ReactElement {
  const { response } = notice;
  const paths: ReactNode[] = [];
  if (typeof response.path === 'string') paths.push(response.path);
  if (typeof response.csvPath === 'string') paths.push(response.csvPath);
  if (typeof response.pdfPath === 'string') paths.push(response.pdfPath);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      style={{
        marginTop: '0.75rem',
        padding: '0.75rem',
        border: '1px solid #2a8',
        color: '#1a6',
        background: '#f3fff7',
        borderRadius: 4,
      }}
    >
      <strong>Export complete</strong>
      <div>
        {response.rowCount} row{response.rowCount === 1 ? '' : 's'} exported.
      </div>
      {paths.length > 0 ? (
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
          {paths.map((p, i) => (
            <li key={i} style={{ wordBreak: 'break-all' }}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface ExportErrorNoticeProps {
  readonly testId: string;
  readonly error: ErrorEnvelope;
}

function ExportErrorNotice({
  testId,
  error,
}: ExportErrorNoticeProps): ReactElement {
  const isCanceled = error.code === 'USER_CANCELED';
  return (
    <div
      role={isCanceled ? 'status' : 'alert'}
      aria-live="polite"
      data-testid={testId}
      style={{
        marginTop: '0.75rem',
        padding: '0.75rem',
        border: `1px solid ${isCanceled ? '#aaa' : '#c33'}`,
        color: isCanceled ? '#555' : '#c33',
        background: isCanceled ? '#fafafa' : '#fff5f5',
        borderRadius: 4,
      }}
    >
      <strong>
        {isCanceled
          ? 'Export canceled'
          : `Export failed (${error.code})`}
      </strong>
      <div>{isCanceled ? 'No file was written.' : error.message}</div>
    </div>
  );
}
