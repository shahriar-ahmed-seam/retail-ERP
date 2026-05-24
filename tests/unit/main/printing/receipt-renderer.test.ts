import { describe, expect, it } from 'vitest';

import {
  buildReceiptDTO,
  loadShopInfoFromSettings,
  SHOP_INFO_SETTING_KEYS,
  type PrismaLike,
} from '@main/printing/receipt-renderer';

import type { ReceiptShopInfo, SaleDTO } from '@shared/dto/index.js';

/**
 * Unit tests for the receipt renderer (Phase 8, task 8.1).
 *
 * Two surfaces under test:
 *
 *   1. `buildReceiptDTO(sale, shopInfo)` — pure shape mapping. The
 *      assertions cover the full per-field projection and confirm that
 *      decimal strings flow through verbatim (no rounding, no
 *      reformatting), so the printed receipt and the persisted sale
 *      stay byte-for-byte identical.
 *
 *   2. `loadShopInfoFromSettings(prisma)` — single-round-trip Settings
 *      read with the missing-row / empty-string normalization rules.
 *      Tests use a tiny in-memory `PrismaLike` stub (no Prisma client,
 *      no SQLite) since the function's only dependency is the
 *      `setting.findMany` shape.
 *
 * Validates: Requirement 4.7.
 */

// ---------------------------------------------------------------------------
// PrismaLike test harness
// ---------------------------------------------------------------------------

/**
 * Build a `PrismaLike` whose `setting.findMany` returns whatever rows
 * are present in the supplied map (filtered by the `key.in` clause to
 * mirror the real Prisma query). Missing keys are simply absent from
 * the result, exactly as Prisma would behave on an unseeded DB.
 */
function makePrismaStub(settings: ReadonlyMap<string, string>): PrismaLike {
  return {
    setting: {
      findMany: (args: {
        where: { key: { in: readonly string[] } };
        select?: { key: true; value: true };
      }) => {
        const requested = new Set<string>(args.where.key.in);
        const rows: { key: string; value: string }[] = [];
        settings.forEach((value: string, key: string) => {
          if (requested.has(key)) {
            rows.push({ key, value });
          }
        });
        return Promise.resolve(rows);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Reference `SaleDTO` modeled on the shape returned by
 * `pos.service.ts#toSaleDTO`. Two lines (different tax rates), one
 * cash payment, an attached customer — enough to exercise every
 * field of the renderer without testing every permutation.
 */
const SAMPLE_SALE: SaleDTO = {
  id: 'sale-1',
  serialNo: 'INV-000123',
  customerId: 'cust-1',
  customerName: 'Alice Lee',
  cashierId: 'user-1',
  cashierName: 'cashier-01',
  subtotal: '20.00',
  discount: '2.00',
  taxTotal: '1.80',
  grandTotal: '19.80',
  createdAt: '2026-05-24T07:38:08.000Z',
  items: [
    {
      id: 'item-1',
      productId: 'prod-1',
      productName: 'Widget',
      quantity: 2,
      unitPrice: '5.00',
      taxRate: '0.10',
      lineTotal: '10.00',
    },
    {
      id: 'item-2',
      productId: 'prod-2',
      productName: 'Gadget',
      quantity: 1,
      unitPrice: '10.00',
      taxRate: '0.05',
      lineTotal: '10.00',
    },
  ],
  payments: [
    {
      id: 'pay-1',
      method: 'cash',
      amount: '19.80',
    },
  ],
};

const SAMPLE_SHOP_INFO: ReceiptShopInfo = {
  name: 'Core Retail Shop',
  address: '123 Market St',
  phone: '555-0100',
  taxId: 'TAX-12345',
};

// ---------------------------------------------------------------------------
// buildReceiptDTO
// ---------------------------------------------------------------------------

describe('buildReceiptDTO', () => {
  it('maps every header field from the sale and shop info', () => {
    const receipt = buildReceiptDTO(SAMPLE_SALE, SAMPLE_SHOP_INFO);

    expect(receipt.shopInfo).toEqual(SAMPLE_SHOP_INFO);
    expect(receipt.serialNo).toBe('INV-000123');
    expect(receipt.createdAt).toBe('2026-05-24T07:38:08.000Z');
    expect(receipt.cashierName).toBe('cashier-01');
    expect(receipt.customerName).toBe('Alice Lee');
    expect(receipt.subtotal).toBe('20.00');
    expect(receipt.discount).toBe('2.00');
    expect(receipt.taxTotal).toBe('1.80');
    expect(receipt.grandTotal).toBe('19.80');
  });

  it('maps every sale item to a ReceiptLine using productName and the persisted decimals', () => {
    const receipt = buildReceiptDTO(SAMPLE_SALE, SAMPLE_SHOP_INFO);

    expect(receipt.lines).toHaveLength(2);
    expect(receipt.lines[0]).toEqual({
      name: 'Widget',
      quantity: 2,
      unitPrice: '5.00',
      lineTotal: '10.00',
      taxRate: '0.10',
    });
    expect(receipt.lines[1]).toEqual({
      name: 'Gadget',
      quantity: 1,
      unitPrice: '10.00',
      lineTotal: '10.00',
      taxRate: '0.05',
    });
  });

  it('maps every payment to a ReceiptPayment preserving method and amount', () => {
    const receipt = buildReceiptDTO(SAMPLE_SALE, SAMPLE_SHOP_INFO);

    expect(receipt.payments).toHaveLength(1);
    expect(receipt.payments[0]).toEqual({ method: 'cash', amount: '19.80' });
  });

  it('forwards a null customer name unchanged (walk-in sale)', () => {
    const walkIn: SaleDTO = {
      ...SAMPLE_SALE,
      customerId: null,
      customerName: null,
    };

    const receipt = buildReceiptDTO(walkIn, SAMPLE_SHOP_INFO);

    expect(receipt.customerName).toBeNull();
  });

  it('returns empty arrays when the sale has no items or payments', () => {
    // Defensive: pos.service.ts rejects empty carts at validation time,
    // but the renderer is total — no array length assumptions.
    const empty: SaleDTO = {
      ...SAMPLE_SALE,
      items: [],
      payments: [],
    };

    const receipt = buildReceiptDTO(empty, SAMPLE_SHOP_INFO);

    expect(receipt.lines).toEqual([]);
    expect(receipt.payments).toEqual([]);
  });

  it('does not mutate the input sale or shop info', () => {
    const saleBefore = JSON.stringify(SAMPLE_SALE);
    const shopBefore = JSON.stringify(SAMPLE_SHOP_INFO);

    buildReceiptDTO(SAMPLE_SALE, SAMPLE_SHOP_INFO);

    expect(JSON.stringify(SAMPLE_SALE)).toBe(saleBefore);
    expect(JSON.stringify(SAMPLE_SHOP_INFO)).toBe(shopBefore);
  });
});

// ---------------------------------------------------------------------------
// loadShopInfoFromSettings
// ---------------------------------------------------------------------------

describe('loadShopInfoFromSettings', () => {
  it('returns the four fields when every Setting row is present', async () => {
    const prisma = makePrismaStub(
      new Map([
        [SHOP_INFO_SETTING_KEYS.name, 'Core Retail Shop'],
        [SHOP_INFO_SETTING_KEYS.address, '123 Market St'],
        [SHOP_INFO_SETTING_KEYS.phone, '555-0100'],
        [SHOP_INFO_SETTING_KEYS.taxId, 'TAX-12345'],
      ]),
    );

    const shopInfo = await loadShopInfoFromSettings(prisma);

    expect(shopInfo).toEqual({
      name: 'Core Retail Shop',
      address: '123 Market St',
      phone: '555-0100',
      taxId: 'TAX-12345',
    });
  });

  it('defaults shop.name to "Shop" when the row is missing', async () => {
    const prisma = makePrismaStub(
      new Map([
        [SHOP_INFO_SETTING_KEYS.address, '123 Market St'],
        [SHOP_INFO_SETTING_KEYS.phone, '555-0100'],
        [SHOP_INFO_SETTING_KEYS.taxId, 'TAX-12345'],
      ]),
    );

    const shopInfo = await loadShopInfoFromSettings(prisma);

    expect(shopInfo.name).toBe('Shop');
    expect(shopInfo.address).toBe('123 Market St');
    expect(shopInfo.phone).toBe('555-0100');
    expect(shopInfo.taxId).toBe('TAX-12345');
  });

  it('defaults the optional fields to null when their rows are missing', async () => {
    const prisma = makePrismaStub(
      new Map([[SHOP_INFO_SETTING_KEYS.name, 'Core Retail Shop']]),
    );

    const shopInfo = await loadShopInfoFromSettings(prisma);

    expect(shopInfo).toEqual({
      name: 'Core Retail Shop',
      address: null,
      phone: null,
      taxId: null,
    });
  });

  it('returns all defaults when no shop-info rows are present', async () => {
    const prisma = makePrismaStub(new Map());

    const shopInfo = await loadShopInfoFromSettings(prisma);

    expect(shopInfo).toEqual({
      name: 'Shop',
      address: null,
      phone: null,
      taxId: null,
    });
  });

  it('treats an empty-string value the same as a missing row', async () => {
    // The seed writes empty strings as the unset placeholder; the
    // settings UI may also blank a field. Both must collapse to the
    // missing-row defaults so the renderer suppresses the line.
    const prisma = makePrismaStub(
      new Map([
        [SHOP_INFO_SETTING_KEYS.name, ''],
        [SHOP_INFO_SETTING_KEYS.address, ''],
        [SHOP_INFO_SETTING_KEYS.phone, ''],
        [SHOP_INFO_SETTING_KEYS.taxId, ''],
      ]),
    );

    const shopInfo = await loadShopInfoFromSettings(prisma);

    expect(shopInfo).toEqual({
      name: 'Shop',
      address: null,
      phone: null,
      taxId: null,
    });
  });

  it('treats whitespace-only values the same as empty/missing', async () => {
    const prisma = makePrismaStub(
      new Map([
        [SHOP_INFO_SETTING_KEYS.name, '   '],
        [SHOP_INFO_SETTING_KEYS.address, '\t\n'],
        [SHOP_INFO_SETTING_KEYS.phone, ' '],
        [SHOP_INFO_SETTING_KEYS.taxId, '  '],
      ]),
    );

    const shopInfo = await loadShopInfoFromSettings(prisma);

    expect(shopInfo).toEqual({
      name: 'Shop',
      address: null,
      phone: null,
      taxId: null,
    });
  });

  it('queries Prisma exactly once for the four well-known keys', async () => {
    let callCount = 0;
    let receivedKeys: readonly string[] = [];
    const prisma: PrismaLike = {
      setting: {
        findMany: (args: {
          where: { key: { in: readonly string[] } };
          select?: { key: true; value: true };
        }) => {
          callCount += 1;
          receivedKeys = args.where.key.in;
          return Promise.resolve([]);
        },
      },
    };

    await loadShopInfoFromSettings(prisma);

    expect(callCount).toBe(1);
    expect([...receivedKeys].sort()).toEqual(
      ['shop.address', 'shop.name', 'shop.phone', 'shop.taxId'].sort(),
    );
  });
});
