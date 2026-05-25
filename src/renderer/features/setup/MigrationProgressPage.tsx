/**
 * Migration progress screen (Phase 16, task 16.7).
 *
 * Minimal full-screen window shown ONLY during pending migrations.
 * The first-run bootstrap (`src/main/bootstrap/first-run.ts`) opens
 * a dedicated `BrowserWindow` that loads the renderer bundle with
 * `?migration=true`, so the renderer entry mounts this page
 * directly (bypassing auth, the router, and every feature module).
 *
 * UI contract:
 *
 *   - App title (`Core Retail ERP`).
 *   - Single line of progress text driven by the active phase:
 *
 *       phase === 'preparing'  → `Preparing database…`
 *       phase === 'applying'   → `Applying migration N of M…`
 *       phase === 'done'       → `Done`
 *       phase === 'error'      → recovery prompt copy from the
 *                                 Phase 11 task 11.6 design (the
 *                                 same wording the integrity-check
 *                                 recovery surface uses) with the
 *                                 underlying error message.
 *
 *   - Indeterminate spinner. Pure CSS keyframe so the page has zero
 *     external assets — important because this window is shown
 *     before the rest of the app's UI bundle is exercised.
 *
 *   - No navigation, no other modules reachable. The migration
 *     window is a deliberate dead-end — on success the main process
 *     destroys the window and opens the main application window;
 *     on error the recovery prompt copy is shown until the
 *     operator (via the bootstrap's recovery flow) makes a choice.
 *
 * Validates: Requirements 14.2, 14.9.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';

import type { MigrationProgressEvent } from '@shared/migration';

// ---------------------------------------------------------------------------
// Subscription seam
// ---------------------------------------------------------------------------
//
// In production the renderer subscribes via the preload bridge
// (`window.setupApi.onMigrationProgress`). The page accepts an
// `onSubscribe` prop so unit tests can drive the phase machine
// directly without touching `globalThis.window`.

/**
 * Function returning an unsubscribe callback. Mirrors the shape of
 * `window.setupApi.onMigrationProgress` so the production wiring is a
 * trivial passthrough.
 */
export type MigrationProgressSubscriber = (
  handler: (event: MigrationProgressEvent) => void,
) => () => void;

/**
 * Default production subscriber. Reads `window.setupApi` lazily so
 * unit tests that mount the component without the preload bridge
 * still render the initial state cleanly.
 */
const defaultSubscriber: MigrationProgressSubscriber = (handler) => {
  // No-op cleanup used when the preload bridge is unavailable; the
  // page still mounts, just without live progress events.
  const noop = (): void => {
    /* nothing to detach */
  };
  if (typeof window === 'undefined') {
    return noop;
  }
  const setupApi = (window as Window & {
    setupApi?: {
      onMigrationProgress: (
        h: (event: MigrationProgressEvent) => void,
      ) => () => void;
    };
  }).setupApi;
  if (setupApi === undefined) {
    return noop;
  }
  return setupApi.onMigrationProgress(handler);
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export interface MigrationProgressPageProps {
  /**
   * Override for the subscription seam. Production callers omit this
   * argument; tests pass a deterministic stub.
   */
  readonly subscribe?: MigrationProgressSubscriber;
}

/**
 * Compute the single line of progress text for the given event. Pure
 * function so tests can assert the message text without mounting the
 * tree.
 */
export function progressTextFor(event: MigrationProgressEvent | null): string {
  if (event === null || event.phase === 'preparing') {
    return 'Preparing database…';
  }
  if (event.phase === 'applying') {
    return `Applying migration ${event.current} of ${event.total}…`;
  }
  if (event.phase === 'done') {
    return 'Done';
  }
  return 'Database update failed.';
}

export function MigrationProgressPage({
  subscribe = defaultSubscriber,
}: MigrationProgressPageProps = {}): ReactElement {
  const [event, setEvent] = useState<MigrationProgressEvent | null>(null);

  useEffect(() => {
    const unsubscribe = subscribe((next) => {
      setEvent(next);
    });
    return () => {
      unsubscribe();
    };
  }, [subscribe]);

  const isError = event !== null && event.phase === 'error';
  const text = useMemo(() => progressTextFor(event), [event]);

  return (
    <main
      data-testid="migration-progress-page"
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.5rem',
        padding: '2rem',
        background: '#0f172a',
        color: '#f8fafc',
        fontFamily: 'system-ui, sans-serif',
        textAlign: 'center',
      }}
    >
      <h1
        style={{
          fontSize: '1.5rem',
          fontWeight: 600,
          margin: 0,
          letterSpacing: '0.02em',
        }}
      >
        Core Retail ERP
      </h1>

      {!isError ? (
        <div
          aria-hidden="true"
          data-testid="migration-progress-spinner"
          style={{
            width: '3rem',
            height: '3rem',
            borderRadius: '50%',
            border: '4px solid rgba(248, 250, 252, 0.18)',
            borderTopColor: '#f8fafc',
            animation: 'migration-spinner 0.9s linear infinite',
          }}
        />
      ) : null}

      <p
        data-testid="migration-progress-text"
        style={{
          margin: 0,
          fontSize: '1rem',
          color: isError ? '#fca5a5' : '#e2e8f0',
        }}
      >
        {text}
      </p>

      {isError ? (
        <div
          data-testid="migration-progress-recovery"
          role="alert"
          aria-live="assertive"
          style={{
            maxWidth: '32rem',
            padding: '1rem 1.25rem',
            border: '1px solid #f87171',
            borderRadius: 6,
            background: 'rgba(248, 113, 113, 0.08)',
            color: '#fecaca',
            fontSize: '0.9375rem',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ display: 'block', marginBottom: '0.5rem' }}>
            Database update could not complete.
          </strong>
          <span data-testid="migration-progress-error-message">
            {event !== null && event.phase === 'error' ? event.message : ''}
          </span>
          <p style={{ margin: '0.75rem 0 0' }}>
            The application will now switch to the recovery flow. The main
            window will not open until the database is restored.
          </p>
        </div>
      ) : null}

      {/* Inline keyframes — keeps the page self-contained so a missing
          stylesheet at startup cannot leave the spinner static. */}
      <style>{`
        @keyframes migration-spinner {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </main>
  );
}
