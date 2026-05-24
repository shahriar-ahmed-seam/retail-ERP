// tests/integration/report-export.test.ts
//
// Phase 10, tasks 10.5–10.7 — integration test for the streaming
// CSV + PDF export pipeline.
//
// Drives the real `exportReport` entry point against a per-test
// SQLite database (via the `temp-db` fixture). After finalizing a
// few sales through `POSService.finalizeSale`, the test triggers a
// CSV-and-PDF export of `dailySales` to a temp directory and
// asserts:
//
//   1. Both files exist on disk and are non-empty.
//   2. The CSV's parsed row count matches the seeded sales count
//      and the header row carries the expected column labels.
//   3. The combined response carries `{ csvPath, pdfPath, rowCount }`
//      with `rowCount` matching the persisted sale count.
//   4. The PDF starts with the `%PDF-` magic so we know pdfkit
//      flushed a real document (not just empty bytes).
//
// The export pipeline pumps rows through `paginateCursor` against
// the same `(createdAt DESC, id)` index every list channel uses,
// so a successful end-to-end exercise here covers the cursor +
// papaparse + pdfkit + write-stream chain in one shot.
//
// Validates: Requirements 9.5, 16.3, 16.6.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseCsv } from 'papaparse';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDb, type TempDbFixture } from './fixtures/temp-db.js';

import type { FinalizeSaleInput, PaymentMethod } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let fixture: TempDbFixture;
let tempDir: string;

interface SeedData {
  readonly actor: { id: string; username: string };
  readonly product: { id: string; sku: string; name: string };
}

async function seed(): Promise<SeedData> {
  const cashierRole = await fixture.prisma.role.findUniqueOrThrow({
    where: { name: 'Cashier' },
  });
  const actor = await fixture.prisma.user.create({
    data: {
      username: 'export-cashier',
      passwordHash: 'not-a-real-hash',
      roleId: cashierRole.id,
    },
  });
  const category = await fixture.prisma.category.create({
    data: { name: 'Test Cat' },
  });
  const product = await fixture.prisma.product.create({
    data: {
      sku: 'SKU-EX',
      name: 'Export Item',
      categoryId: category.id,
      buyPrice: '5.00',
      sellPrice: '10.00',
      taxRate: '0',
      reorderLevel: 0,
    },
  });
  await fixture.prisma.inventory.create({ data: { productId: product.id, onHand: 100 } });
  return {
    actor: { id: actor.id, username: actor.username },
    product: { id: product.id, sku: product.sku, name: product.name },
  };
}

function makeInput(productId: string, qty: number, method: PaymentMethod): FinalizeSaleInput {
  const lineTotal = qty * 10;
  const fmt = (n: number): string => n.toFixed(2);
  return {
    items: [
      {
        productId,
        quantity: qty,
        unitPrice: '10.00',
        taxRate: '0',
        lineTotal: fmt(lineTotal),
      },
    ],
    discount: { kind: 'fixed', amount: '0' },
    subtotal: fmt(lineTotal),
    discountAmount: '0',
    taxTotal: '0',
    grandTotal: fmt(lineTotal),
    payments: [{ method, amount: fmt(lineTotal) }],
  };
}

beforeEach(async () => {
  fixture = await createTempDb();
  tempDir = mkdtempSync(join(tmpdir(), 'core-retail-erp-export-it-'));
});

afterEach(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  await fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exportReport — integration with finalized sales', () => {
  it('produces both CSV and PDF files matching the persisted sales', async () => {
    const seeded = await seed();

    // Finalize 3 sales of varying quantity.
    const r1 = await fixture.POSService.finalizeSale(
      makeInput(seeded.product.id, 1, 'cash'),
      { userId: seeded.actor.id },
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    await new Promise<void>((res) => setTimeout(res, 2));

    const r2 = await fixture.POSService.finalizeSale(
      makeInput(seeded.product.id, 2, 'card'),
      { userId: seeded.actor.id },
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    await new Promise<void>((res) => setTimeout(res, 2));

    const r3 = await fixture.POSService.finalizeSale(
      makeInput(seeded.product.id, 3, 'mobile'),
      { userId: seeded.actor.id },
    );
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;

    // Day window for the export request.
    const firstSale = await fixture.prisma.sale.findUniqueOrThrow({
      where: { id: r1.value.saleId },
    });
    const dayString = firstSale.createdAt.toISOString().slice(0, 10);

    const csvPath = join(tempDir, 'daily.csv');
    const pdfPath = join(tempDir, 'daily.pdf');

    const result = await fixture.exportReport({
      request: {
        reportId: 'dailySales',
        format: ['csv', 'pdf'],
        filter: { date: dayString },
      },
      paths: { csv: csvPath, pdf: pdfPath },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.csvPath).toBe(csvPath);
    expect(result.value.pdfPath).toBe(pdfPath);
    expect(result.value.rowCount).toBe(3);

    // ---- CSV assertions ---------------------------------------------------
    expect(existsSync(csvPath)).toBe(true);
    const csvSize = statSync(csvPath).size;
    expect(csvSize).toBeGreaterThan(0);
    const csvContent = readFileSync(csvPath, 'utf-8');
    const parsed = parseCsv<Record<string, string>>(csvContent, {
      header: true,
      skipEmptyLines: true,
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toHaveLength(3);
    // Every parsed row carries the expected columns.
    const firstRow = parsed.data[0];
    expect(firstRow).toBeDefined();
    if (firstRow !== undefined) {
      expect(firstRow.Serial).toMatch(/^INV-\d+$/);
      expect(firstRow.Cashier).toBe('export-cashier');
      // Default customer is empty (no customer attached).
      expect(firstRow.Customer).toBe('');
    }
    // The serial numbers in the CSV match the persisted sales.
    const csvSerials = parsed.data.map((r) => r.Serial).sort();
    const dbSerials = (
      await fixture.prisma.sale.findMany({
        select: { serialNo: true },
        orderBy: { serialNo: 'asc' },
      })
    ).map((s) => s.serialNo);
    expect(csvSerials).toEqual(dbSerials);

    // ---- PDF assertions --------------------------------------------------
    expect(existsSync(pdfPath)).toBe(true);
    const pdfSize = statSync(pdfPath).size;
    expect(pdfSize).toBeGreaterThan(0);
    const head = readFileSync(pdfPath).slice(0, 5).toString('utf-8');
    expect(head).toBe('%PDF-');
  });

  it('exports the lowStock report to CSV against the real DB', async () => {
    const cashierRole = await fixture.prisma.role.findUniqueOrThrow({
      where: { name: 'Cashier' },
    });
    await fixture.prisma.user.create({
      data: {
        username: 'low-stock-user',
        passwordHash: 'not-a-real-hash',
        roleId: cashierRole.id,
      },
    });
    const category = await fixture.prisma.category.create({
      data: { name: 'LS Cat' },
    });
    const product = await fixture.prisma.product.create({
      data: {
        sku: 'SKU-LS',
        name: 'Low Stock Item',
        categoryId: category.id,
        buyPrice: '1.00',
        sellPrice: '2.00',
        taxRate: '0',
        reorderLevel: 5,
      },
    });
    await fixture.prisma.inventory.create({
      data: { productId: product.id, onHand: 1 },
    });

    const csvPath = join(tempDir, 'low-stock.csv');
    const result = await fixture.exportReport({
      request: { reportId: 'lowStock', format: 'csv' },
      paths: { csv: csvPath },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(csvPath);
    expect(result.value.rowCount).toBe(1);

    const content = readFileSync(csvPath, 'utf-8');
    expect(content).toContain('SKU,Product,On Hand,Reorder Level');
    expect(content).toContain('SKU-LS');
    expect(content).toContain('Low Stock Item');
  });
});
