/**
 * Unit tests for the shared POS totals math (`src/shared/pos-totals.ts`).
 *
 * These tests cover the pure-function contract that both the renderer's
 * live-cart totals and the main process's `pos:finalize` validator depend
 * on. The companion property tests (Properties 2, 4, 8) live in their own
 * subtasks under Phase 7 and are not in scope here.
 *
 * Validates: Requirements 2.6, 4.4, 4.5, 4.6.
 */

import { describe, expect, it } from 'vitest';

import {
  applyDiscount,
  computeGrandTotal,
  computeSubtotal,
  computeTaxTotal,
  validateTotalsIdentity,
  type TotalsItem,
} from '@shared/pos-totals.js';

import type { FinalizeSaleInput } from '@shared/dto/sale.js';

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function line(quantity: number, unitPrice: string, taxRate = '0'): TotalsItem {
  return { quantity, unitPrice, taxRate };
}

/**
 * Build a self-consistent `FinalizeSaleInput` from a cart and discount,
 * with the renderer-supplied totals filled in by re-running the same math
 * the validator will use. Tests then mutate one field at a time to assert
 * the validator catches it.
 */
function selfConsistentInput(
  items: readonly TotalsItem[],
  discount: FinalizeSaleInput['discount'],
  payments: FinalizeSaleInput['payments'] = [],
): FinalizeSaleInput {
  const subtotal = computeSubtotal(items);
  const discountAmount = applyDiscount(subtotal, discount);
  const taxTotal = computeTaxTotal(items, subtotal, discountAmount);
  const grandTotal = computeGrandTotal(subtotal, discountAmount, taxTotal);
  const finalPayments =
    payments.length > 0
      ? payments
      : [{ method: 'cash' as const, amount: grandTotal }];

  return {
    items: items.map((it) => ({
      productId: 'prod-' + it.unitPrice,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      taxRate: it.taxRate,
      lineTotal: '0', // not used by totals math; left as placeholder
    })),
    discount,
    subtotal,
    discountAmount,
    taxTotal,
    grandTotal,
    payments: finalPayments,
  };
}

// ---------------------------------------------------------------------------
// computeSubtotal
// ---------------------------------------------------------------------------

describe('computeSubtotal', () => {
  it('returns 0 for an empty cart', () => {
    expect(computeSubtotal([])).toBe('0');
  });

  it('multiplies quantity by unitPrice for a single line', () => {
    expect(computeSubtotal([line(3, '10.00')])).toBe('30');
  });

  it('sums quantity * unitPrice across multiple lines', () => {
    const items = [line(2, '12.50'), line(1, '7.25'), line(3, '4.00')];
    // 25.00 + 7.25 + 12.00 = 44.25
    expect(computeSubtotal(items)).toBe('44.25');
  });

  it('avoids IEEE-754 drift on classic 0.1 + 0.2 inputs', () => {
    // The float trap: 0.1 + 0.2 === 0.30000000000000004 in JS numbers.
    // Decimal math must produce exactly '0.3'.
    expect(computeSubtotal([line(1, '0.1'), line(1, '0.2')])).toBe('0.3');
  });
});

// ---------------------------------------------------------------------------
// applyDiscount
// ---------------------------------------------------------------------------

describe('applyDiscount', () => {
  it('returns the fixed amount unchanged when within bounds', () => {
    expect(applyDiscount('100', { kind: 'fixed', amount: '15.50' })).toBe('15.5');
  });

  it('clamps a fixed discount that exceeds the subtotal to the subtotal', () => {
    // The post-discount subtotal would otherwise be negative; we cap so
    // grand total can never go below 0.
    expect(applyDiscount('30', { kind: 'fixed', amount: '500' })).toBe('30');
  });

  it('clamps a negative fixed discount to 0', () => {
    expect(applyDiscount('30', { kind: 'fixed', amount: '-10' })).toBe('0');
  });

  it('multiplies subtotal by the percentage ratio', () => {
    // 10% of 100 = 10
    expect(applyDiscount('100', { kind: 'percent', percent: '0.10' })).toBe('10');
  });

  it('clamps a percentage above 100% to 100% (full subtotal)', () => {
    expect(applyDiscount('80', { kind: 'percent', percent: '1.5' })).toBe('80');
  });

  it('clamps a negative percentage to 0', () => {
    expect(applyDiscount('80', { kind: 'percent', percent: '-0.25' })).toBe('0');
  });

  it('returns 0 for any discount when the subtotal is 0', () => {
    expect(applyDiscount('0', { kind: 'fixed', amount: '50' })).toBe('0');
    expect(applyDiscount('0', { kind: 'percent', percent: '0.20' })).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// computeTaxTotal
// ---------------------------------------------------------------------------

describe('computeTaxTotal', () => {
  it('returns 0 for an empty cart', () => {
    expect(computeTaxTotal([], '0', '0')).toBe('0');
  });

  it('returns 0 when every line is tax-exempt', () => {
    const items = [line(2, '50', '0'), line(1, '25', '0')];
    expect(computeTaxTotal(items, '125', '0')).toBe('0');
  });

  it('applies the tax rate to a no-discount subtotal', () => {
    // 1 unit * 100 * 18% = 18
    expect(computeTaxTotal([line(1, '100', '0.18')], '100', '0')).toBe('18');
  });

  it('computes tax on the post-discount subtotal (key requirement 4.5)', () => {
    // 100 subtotal, 10% discount, 18% tax should produce 16.20, NOT 18.00.
    // The renderer-friendly identity: tax == (subtotal - discount) * rate
    // when there is a single uniform rate.
    const items = [line(1, '100', '0.18')];
    expect(computeTaxTotal(items, '100', '10')).toBe('16.2');
  });

  it('allocates a discount proportionally across heterogeneous tax rates', () => {
    // Cart: line A 100 @ 10% tax, line B 100 @ 20% tax. Subtotal 200.
    // 10% off (discountAmount = 20).
    // Surviving share = 1 - 20/200 = 0.9.
    // Tax = 100*0.9*0.10 + 100*0.9*0.20 = 9 + 18 = 27.
    const items = [line(1, '100', '0.10'), line(1, '100', '0.20')];
    expect(computeTaxTotal(items, '200', '20')).toBe('27');
  });

  it('produces 0 tax when the subtotal is 0 (no division by zero)', () => {
    // Hypothetical cart: a 0-quantity line. The proportional factor is
    // undefined but every gross is 0, so tax must be 0.
    const items = [line(0, '50', '0.18')];
    expect(computeTaxTotal(items, '0', '0')).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// computeGrandTotal
// ---------------------------------------------------------------------------

describe('computeGrandTotal', () => {
  it('returns subtotal - discount + tax', () => {
    expect(computeGrandTotal('100', '10', '16.20')).toBe('106.2');
  });

  it('returns the subtotal when both discount and tax are zero', () => {
    expect(computeGrandTotal('42.50', '0', '0')).toBe('42.5');
  });

  it('returns 0 when a full discount cancels the subtotal and there is no tax', () => {
    expect(computeGrandTotal('100', '100', '0')).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// validateTotalsIdentity
// ---------------------------------------------------------------------------

describe('validateTotalsIdentity', () => {
  it('accepts a self-consistent finalize input', () => {
    const input = selfConsistentInput(
      [line(2, '12.50', '0.18'), line(1, '7.00', '0')],
      { kind: 'fixed', amount: '5' },
    );
    expect(validateTotalsIdentity(input)).toEqual({ ok: true });
  });

  it('accepts decimal strings that compare equal but are formatted differently', () => {
    // The renderer often produces `'10.50'` while Decimal canonicalizes to
    // `'10.5'`. The validator must accept both.
    const items = [line(1, '10.50', '0')];
    const input: FinalizeSaleInput = {
      items: [
        {
          productId: 'p1',
          quantity: 1,
          unitPrice: '10.50',
          taxRate: '0',
          lineTotal: '10.50',
        },
      ],
      discount: { kind: 'fixed', amount: '0' },
      subtotal: '10.50',
      discountAmount: '0',
      taxTotal: '0',
      grandTotal: '10.50',
      payments: [{ method: 'cash', amount: '10.50' }],
    };

    expect(computeSubtotal(items)).toBe('10.5'); // sanity: canonical form
    expect(validateTotalsIdentity(input)).toEqual({ ok: true });
  });

  it('rejects a tampered subtotal and reports field=subtotal', () => {
    const baseline = selfConsistentInput(
      [line(2, '10', '0')],
      { kind: 'fixed', amount: '0' },
    );
    const tampered: FinalizeSaleInput = { ...baseline, subtotal: '999' };

    const result = validateTotalsIdentity(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return; // type guard
    expect(result.field).toBe('subtotal');
    expect(result.actual).toBe('999');
    expect(result.expected).toBe('20');
  });

  it('rejects a tampered discount amount and reports field=discountAmount', () => {
    const baseline = selfConsistentInput(
      [line(1, '100', '0')],
      { kind: 'percent', percent: '0.10' },
    );
    const tampered: FinalizeSaleInput = { ...baseline, discountAmount: '50' };

    const result = validateTotalsIdentity(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('discountAmount');
    expect(result.expected).toBe('10');
  });

  it('rejects a tampered tax total and reports field=taxTotal', () => {
    const baseline = selfConsistentInput(
      [line(1, '100', '0.18')],
      { kind: 'fixed', amount: '0' },
    );
    const tampered: FinalizeSaleInput = { ...baseline, taxTotal: '0' };

    const result = validateTotalsIdentity(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('taxTotal');
    expect(result.expected).toBe('18');
  });

  it('rejects a tampered grand total and reports field=grandTotal', () => {
    const baseline = selfConsistentInput(
      [line(2, '50', '0')],
      { kind: 'fixed', amount: '0' },
    );
    const tampered: FinalizeSaleInput = { ...baseline, grandTotal: '50' };

    const result = validateTotalsIdentity(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('grandTotal');
    expect(result.expected).toBe('100');
  });

  it('rejects payments that are off by one cent and reports field=payments', () => {
    const baseline = selfConsistentInput(
      [line(1, '20', '0')],
      { kind: 'fixed', amount: '0' },
    );
    // Drop a cent from the cash payment so sum(payments) != grandTotal.
    const tampered: FinalizeSaleInput = {
      ...baseline,
      payments: [{ method: 'cash', amount: '19.99' }],
    };

    const result = validateTotalsIdentity(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('payments');
    expect(result.expected).toBe('20');
    expect(result.actual).toBe('19.99');
  });

  it('accepts split payments whose sum equals grand total', () => {
    const items = [line(1, '100', '0')];
    const input: FinalizeSaleInput = {
      items: [
        { productId: 'p1', quantity: 1, unitPrice: '100', taxRate: '0', lineTotal: '100' },
      ],
      discount: { kind: 'fixed', amount: '0' },
      subtotal: '100',
      discountAmount: '0',
      taxTotal: '0',
      grandTotal: '100',
      payments: [
        { method: 'cash', amount: '60' },
        { method: 'card', amount: '40' },
      ],
    };

    expect(computeSubtotal(items)).toBe('100'); // sanity
    expect(validateTotalsIdentity(input)).toEqual({ ok: true });
  });

  it('honours the optional tolerance for legacy ingest paths', () => {
    const baseline = selfConsistentInput(
      [line(1, '20', '0')],
      { kind: 'fixed', amount: '0' },
    );
    // 1 cent under exact — exact mode rejects, 0.01 tolerance accepts.
    const drifted: FinalizeSaleInput = {
      ...baseline,
      payments: [{ method: 'cash', amount: '19.99' }],
    };

    expect(validateTotalsIdentity(drifted).ok).toBe(false);
    expect(validateTotalsIdentity(drifted, { tolerance: '0.01' })).toEqual({ ok: true });
  });
});
