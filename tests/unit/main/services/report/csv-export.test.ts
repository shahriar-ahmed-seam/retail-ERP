import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `exportCsv` (Phase 10, task 10.5).
 *
 * Drives the streaming CSV exporter against an in-memory write
 * stream stub and a mocked `pumpRows` so each batch the encoder
 * receives is deterministic. The tests assert:
 *
 *   - The header row is emitted on the first batch only.
 *   - Subsequent batches contain only data rows.
 *   - Each batch produces a complete CSV chunk (trailing newline).
 *   - The promise resolves only after the stream's `finish` event.
 *   - Stream errors propagate as `Err('INTERNAL', { reason: 'io' })`.
 *   - A pump-level Err propagates verbatim through the encoder.
 *
 * Validates: Requirements 9.5, 16.3, 16.6.
 */

// ---------------------------------------------------------------------------
// Hoisted mock for the shared cursor pump
// ---------------------------------------------------------------------------

const pumpMock = vi.hoisted(() => ({
  pumpRows: vi.fn(),
}));

vi.mock('@main/services/report/pump', async (importActual) => {
  const actual = await importActual<typeof import('@main/services/report/pump')>();
  return {
    ...actual,
    pumpRows: pumpMock.pumpRows,
  };
});

vi.mock('@main/services/report/pump.js', async (importActual) => {
  const actual =
    await importActual<typeof import('@main/services/report/pump.js')>();
  return {
    ...actual,
    pumpRows: pumpMock.pumpRows,
  };
});

import { exportCsv } from '@main/services/report/csv-export';
import { Err, Ok } from '@shared/result';

import type { ExportRow } from '@main/services/report/pump';
import type { Result } from '@shared/result';

// ---------------------------------------------------------------------------
// In-memory write stream stub
// ---------------------------------------------------------------------------

interface FakeWriteStream extends EventEmitter {
  readonly chunks: string[];
  finished: boolean;
  errorOnWrite?: Error;
  write(chunk: string): boolean;
  end(): void;
  destroy(): void;
}

function makeStream(): FakeWriteStream {
  const e = new EventEmitter();
  const stream = e as FakeWriteStream;
  stream.chunks = [];
  stream.finished = false;
  stream.write = (chunk: string) => {
    if (stream.errorOnWrite) {
      // Fire `error` asynchronously to mirror Node's stream semantics.
      setImmediate(() => stream.emit('error', stream.errorOnWrite));
      return false;
    }
    stream.chunks.push(chunk);
    return true;
  };
  stream.end = () => {
    stream.finished = true;
    setImmediate(() => stream.emit('finish'));
  };
  stream.destroy = () => {
    /* no-op for these tests */
  };
  return stream;
}

const fakeFs = {
  createWriteStream: vi.fn(),
};

beforeEach(() => {
  pumpMock.pumpRows.mockReset();
  fakeFs.createWriteStream.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Happy-path: header on first batch only
// ---------------------------------------------------------------------------

describe('exportCsv', () => {
  it('emits the header on the first batch only and writes one chunk per batch', async () => {
    const stream = makeStream();
    fakeFs.createWriteStream.mockReturnValue(stream);

    pumpMock.pumpRows.mockImplementation(
      async (
        _opts: unknown,
        consumer: (
          batch: readonly ExportRow[],
          meta: { batchIndex: number; isLast: boolean },
        ) => Promise<void>,
      ): Promise<Result<{ rowCount: number }>> => {
        await consumer(
          [
            {
              productId: 'p-1',
              sku: 'SKU-1',
              name: 'Alpha',
              onHand: 1,
              reorderLevel: 5,
            },
          ] as ExportRow[],
          { batchIndex: 0, isLast: false },
        );
        await consumer(
          [
            {
              productId: 'p-2',
              sku: 'SKU-2',
              name: 'Beta',
              onHand: 0,
              reorderLevel: 3,
            },
          ] as ExportRow[],
          { batchIndex: 1, isLast: true },
        );
        return Ok({ rowCount: 2 });
      },
    );

    const result = await exportCsv({
      request: { reportId: 'lowStock', format: 'csv' },
      path: '/tmp/test.csv',
      fs: fakeFs,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ path: '/tmp/test.csv', rowCount: 2 });
    expect(stream.chunks).toHaveLength(2);
    // First chunk includes the header line + first data row.
    expect(stream.chunks[0]).toContain('SKU,Product,On Hand,Reorder Level');
    expect(stream.chunks[0]).toContain('SKU-1,Alpha,1,5');
    // Second chunk has only the data row, no repeated header.
    expect(stream.chunks[1]).not.toContain('SKU,Product');
    expect(stream.chunks[1]).toContain('SKU-2,Beta,0,3');
    // Both chunks end with a newline so subsequent rows do not concat.
    for (const c of stream.chunks) {
      expect(c.endsWith('\n')).toBe(true);
    }
    expect(stream.finished).toBe(true);
  });

  it('resolves Err when pumpRows returns an Err envelope', async () => {
    const stream = makeStream();
    fakeFs.createWriteStream.mockReturnValue(stream);

    pumpMock.pumpRows.mockResolvedValue(Err('VALIDATION', { field: 'date' }));

    const result = await exportCsv({
      request: { reportId: 'dailySales', format: 'csv', filter: { date: 'bad' } },
      path: '/tmp/bad.csv',
      fs: fakeFs,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'date' });
    }
  });

  it('returns INTERNAL when createWriteStream throws', async () => {
    fakeFs.createWriteStream.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = await exportCsv({
      request: { reportId: 'lowStock', format: 'csv' },
      path: '/tmp/denied.csv',
      fs: fakeFs,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.details).toMatchObject({ reason: 'io', cause: 'EACCES' });
    }
  });

  it('returns INTERNAL when the stream emits an error before finish', async () => {
    const stream = makeStream();
    fakeFs.createWriteStream.mockReturnValue(stream);

    pumpMock.pumpRows.mockImplementation(
      async (
        _opts: unknown,
        consumer: (
          batch: readonly ExportRow[],
          meta: { batchIndex: number; isLast: boolean },
        ) => Promise<void>,
      ): Promise<Result<{ rowCount: number }>> => {
        // Schedule a stream error to fire while the consumer is
        // running. The CSV encoder MUST settle to an Err envelope.
        setImmediate(() => stream.emit('error', new Error('disk full')));
        await consumer([] as ExportRow[], { batchIndex: 0, isLast: true });
        return Ok({ rowCount: 0 });
      },
    );

    const result = await exportCsv({
      request: { reportId: 'lowStock', format: 'csv' },
      path: '/tmp/err.csv',
      fs: fakeFs,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
    }
  });
});
