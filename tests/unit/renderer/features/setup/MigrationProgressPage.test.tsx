/**
 * Unit tests for the migration progress screen (Phase 16, task 16.7).
 *
 * Mounts the page with an injected `subscribe` callback so the test can
 * drive the phase machine through the same `setup:migrationProgress`
 * shape the main process emits in production.
 *
 * Coverage:
 *   - Initial render shows the `Preparing database…` copy + spinner.
 *   - `applying` events advance to `Applying migration N of M…`.
 *   - `done` flips the copy to `Done` (spinner still visible).
 *   - `error` swaps in the recovery prompt copy and hides the spinner.
 *   - The component unsubscribes on unmount.
 *
 * Validates: Requirements 14.2, 14.9.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MigrationProgressPage,
  progressTextFor,
} from '@renderer/features/setup/MigrationProgressPage';

import type { MigrationProgressEvent } from '@shared/migration';

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Builder for the subscriber stub. Captures the listener so tests can
 * drive arbitrary event sequences and asserts the unsubscribe path.
 */
function buildSubscriber(): {
  subscribe: (handler: (event: MigrationProgressEvent) => void) => () => void;
  emit: (event: MigrationProgressEvent) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
  subscribed: boolean;
} {
  let active: ((event: MigrationProgressEvent) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    active = null;
  });
  const subscribe = (
    handler: (event: MigrationProgressEvent) => void,
  ): (() => void) => {
    active = handler;
    return unsubscribe;
  };
  return {
    subscribe,
    emit: (event) => {
      if (active !== null) active(event);
    },
    unsubscribe,
    get subscribed() {
      return active !== null;
    },
  };
}

describe('progressTextFor', () => {
  it('returns the preparing copy for null and preparing events', () => {
    expect(progressTextFor(null)).toBe('Preparing database…');
    expect(progressTextFor({ phase: 'preparing' })).toBe('Preparing database…');
  });

  it('renders 1-based migration counts in the applying copy', () => {
    expect(
      progressTextFor({ phase: 'applying', current: 1, total: 3 }),
    ).toBe('Applying migration 1 of 3…');
    expect(
      progressTextFor({ phase: 'applying', current: 3, total: 3 }),
    ).toBe('Applying migration 3 of 3…');
  });

  it('returns the done copy for done', () => {
    expect(progressTextFor({ phase: 'done' })).toBe('Done');
  });

  it('returns the error copy for error', () => {
    expect(progressTextFor({ phase: 'error', message: 'x' })).toBe(
      'Database update failed.',
    );
  });
});

describe('<MigrationProgressPage />', () => {
  it('renders the preparing copy and the spinner on initial mount', () => {
    const sub = buildSubscriber();
    render(<MigrationProgressPage subscribe={sub.subscribe} />);

    expect(screen.getByTestId('migration-progress-page')).toBeInTheDocument();
    expect(screen.getByTestId('migration-progress-text')).toHaveTextContent(
      'Preparing database…',
    );
    expect(
      screen.getByTestId('migration-progress-spinner'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('migration-progress-recovery'),
    ).not.toBeInTheDocument();
  });

  it('advances the copy when applying events arrive', () => {
    const sub = buildSubscriber();
    render(<MigrationProgressPage subscribe={sub.subscribe} />);

    act(() => {
      sub.emit({ phase: 'applying', current: 1, total: 3 });
    });
    expect(screen.getByTestId('migration-progress-text')).toHaveTextContent(
      'Applying migration 1 of 3…',
    );

    act(() => {
      sub.emit({ phase: 'applying', current: 2, total: 3 });
    });
    expect(screen.getByTestId('migration-progress-text')).toHaveTextContent(
      'Applying migration 2 of 3…',
    );
  });

  it('flips to the done copy when the bootstrap reports done', () => {
    const sub = buildSubscriber();
    render(<MigrationProgressPage subscribe={sub.subscribe} />);

    act(() => {
      sub.emit({ phase: 'done' });
    });
    expect(screen.getByTestId('migration-progress-text')).toHaveTextContent(
      'Done',
    );
    // Spinner stays visible momentarily; the bootstrap destroys the
    // window before the user can read more than the message.
    expect(
      screen.getByTestId('migration-progress-spinner'),
    ).toBeInTheDocument();
  });

  it('switches to the recovery prompt copy on error', () => {
    const sub = buildSubscriber();
    render(<MigrationProgressPage subscribe={sub.subscribe} />);

    act(() => {
      sub.emit({
        phase: 'error',
        message: 'P1001: cannot reach database server',
      });
    });

    expect(screen.getByTestId('migration-progress-text')).toHaveTextContent(
      'Database update failed.',
    );
    // Spinner is hidden once the error surface is up.
    expect(
      screen.queryByTestId('migration-progress-spinner'),
    ).not.toBeInTheDocument();

    const recovery = screen.getByTestId('migration-progress-recovery');
    expect(recovery).toBeInTheDocument();
    expect(
      screen.getByTestId('migration-progress-error-message'),
    ).toHaveTextContent('P1001: cannot reach database server');
  });

  it('unsubscribes from the channel on unmount', () => {
    const sub = buildSubscriber();
    const { unmount } = render(
      <MigrationProgressPage subscribe={sub.subscribe} />,
    );

    expect(sub.subscribed).toBe(true);
    unmount();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub.subscribed).toBe(false);
  });
});
