/**
 * POS single-screen layout (tasks 7.5 + 7.6, Phase 7).
 *
 * The cashier-facing surface for the `pos:scan` and `pos:finalize`
 * channels. The page lives in one screen — scanner input on top, cart
 * in the middle, totals + discount + customer attach on the right,
 * payment panel + finalize button at the bottom — so a sale can be
 * driven without ever leaving keyboard focus on the scanner input
 * (Req 4.1, 14.3).
 *
 * The cart is renderer-only state per design.md > "POS Flow" — nothing
 * about a sale exists in the database until `pos:finalize` is called.
 * That is what makes the 200 ms scan target achievable: scan is just a
 * `findUnique` on `Product.barcode`. Live totals are computed from the
 * cart through `@shared/pos-totals` (the same module the main process
 * re-runs inside the finalize transaction), so the renderer's numbers
 * agree to the bit with `validateTotalsIdentity` and Property 2 holds
 * trivially at the contract boundary.
 *
 * Server-error mapping (`POSService.finalizeSale` envelopes):
 *   - `VALIDATION { field, expected?, actual? }` → page-level banner
 *     carrying the field name + message + (when present) the
 *     expected/actual decimal strings.
 *   - `OUT_OF_STOCK { productId }`            → that product's cart
 *     line(s) flagged inline; finalize stays disabled while the flag
 *     is set. The cart is NOT cleared.
 *   - `FK_VIOLATION`                          → page-level banner with
 *     the "customer or product not found — please refresh and try
 *     again." copy.
 *   - Other envelopes (`INTERNAL`, `UNAUTHENTICATED`, …)            →
 *     page-level banner showing the envelope code + message. Toasts
 *     for `INTERNAL`/`UNAUTHENTICATED` are still surfaced by
 *     `useApi()`.
 *
 * Customer attach is wired against the existing `customers:list`
 * channel so a cashier can pick a registered customer. An inline
 * "+ New customer" form sits next to the search input — submitting
 * it calls `customers:upsert` and on success selects the new
 * customer as the attached one (the IPC matrix authorizes
 * `customers:upsert` for both Admin and Cashier per Req 7.2 so the
 * POS can capture a walk-in's contact details mid-checkout). Walk-in
 * sales send `customerId: null` on the wire (Req 7.4).
 *
 * Validates: Requirements 4.1, 4.4, 4.5, 4.6, 7.2, 7.4, 14.3, 13.5.
 */

import Decimal from 'decimal.js';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';

import { useApi } from '@renderer/lib/api';
import {
  applyDiscount,
  computeGrandTotal,
  computeSubtotal,
  computeTaxTotal,
  type TotalsItem,
} from '@shared/pos-totals';

import type {
  CustomerDTO,
  DiscountInput,
  FinalizeSaleInput,
  PaymentInput,
  PaymentMethod,
  ProductDTO,
  SaleDTO,
  SaleItemInput,
} from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the customer typeahead (matches AdjustPage / PurchaseCreatePage). */
const CUSTOMER_SEARCH_DEBOUNCE_MS = 250;
const CUSTOMER_SEARCH_PAGE_SIZE = 20;

/**
 * Brief settle delay used by the scanner input's auto-submit branch.
 * Real USB scanners terminate the keystroke burst with a CR/LF that
 * triggers the form's native submit; this fallback covers cases where
 * the scanner is configured without a terminator and the cashier is
 * manually keying a barcode.
 */
const SCANNER_SETTLE_DELAY_MS = 200;

/**
 * Minimum length before the auto-submit settle path will fire. Below
 * this threshold the input is more likely to be a partial keystroke
 * burst than a complete barcode; the cashier still has the Enter key
 * and the burst-terminator path.
 */
const SCANNER_MIN_BARCODE_LENGTH = 4;

/** Ordered tuple of accepted payment methods. Drives the payment buttons. */
const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'card', 'mobile'] as const;

/** Pretty label for a payment method — used on buttons + the payments list. */
const PAYMENT_LABEL: Readonly<Record<PaymentMethod, string>> = {
  cash: 'Cash',
  card: 'Card',
  mobile: 'Mobile',
};

/**
 * Keyboard-shortcut hints surfaced via `title` on each payment button.
 * Mirrors design.md > "Keyboard-first cashier flow": F4 cash, F5 card,
 * F6 mobile.
 */
const PAYMENT_SHORTCUT_HINT: Readonly<Record<PaymentMethod, string>> = {
  cash: 'Pay cash (F4)',
  card: 'Pay card (F5)',
  mobile: 'Pay mobile (F6)',
};

// ---------------------------------------------------------------------------
// Local cart + payment state
// ---------------------------------------------------------------------------

/**
 * One entry in the cart. `rowId` is opaque and stable across re-renders
 * (so React's `key` survives a mid-cart removal); the cashier-facing
 * identity is `product.id`. Quantity is held as an integer; the renderer
 * never sends fractional quantities to the wire.
 */
interface CartLine {
  readonly rowId: string;
  readonly product: ProductDTO;
  readonly quantity: number;
}

/**
 * One payment captured in the renderer. The wire shape is
 * `{ method, amount }` — `rowId` is renderer-only so the payments list
 * can be edited without identity drift.
 */
interface PaymentEntry {
  readonly rowId: string;
  readonly method: PaymentMethod;
  readonly amount: string;
}

/** Successful finalize notice rendered above the form. */
interface SuccessNotice {
  readonly saleId: string;
  readonly serialNo: string;
}

// ---------------------------------------------------------------------------
// Helpers (cart math, decimal formatting)
// ---------------------------------------------------------------------------

/**
 * Per-line gross helper used both for the cart row's "Line total"
 * column and for the wire `lineTotal` value. Mirrors the math
 * `pos-totals#computeSubtotal` runs internally so the per-line value
 * the cashier sees agrees with the per-line `quantity * unitPrice`
 * identity `POSService.finalizeSale#validateLine` enforces server-side.
 */
function computeLineTotal(line: CartLine): string {
  return new Decimal(line.product.sellPrice).times(line.quantity).toString();
}

/**
 * Pretty-print a decimal string at a fixed precision so the totals
 * column reads cleanly even when the underlying value drops trailing
 * zeros (`'10.5'` → `'10.50'`). `Decimal.toFixed(2)` rounds half-up,
 * which is what cashiers expect for register totals.
 */
function formatMoney(value: string): string {
  try {
    return new Decimal(value).toFixed(2);
  } catch {
    return '0.00';
  }
}

/**
 * Sanitize a user-typed monetary input. Allows mid-typing fragments
 * like `'0.'` or `''` to flow through unchanged so the input element
 * does not lose the user's caret position. A leading minus sign is
 * stripped (the discount inputs are non-negative); anything else
 * outside the decimal grammar is rejected and the previous value is
 * preserved by returning it.
 */
function sanitizeDecimalInput(raw: string, previous: string): string {
  // Allow empty (lets the cashier clear the field).
  if (raw === '') return '';
  // Strip a leading minus — non-negative input.
  const cleaned = raw.replace(/^-+/, '');
  // Accept the decimal grammar OR a trailing-dot fragment.
  if (/^\d+(\.\d*)?$/.test(cleaned) || /^\.\d*$/.test(cleaned)) {
    return cleaned;
  }
  return previous;
}

/**
 * Coerce a possibly mid-typing decimal string into a wire-shaped
 * decimal `'0'` (or the input itself when fully formed). Used inside
 * the totals memo and the finalize wire builder so a fragment like
 * `'0.'` never reaches `pos-totals`'s strict parser.
 */
function normalizeDecimalForMath(raw: string): string {
  if (raw === '' || raw === '.') return '0';
  if (/^\d+(\.\d+)?$/.test(raw)) return raw;
  // Trailing-dot fragments collapse to the integer prefix.
  const m = /^(\d+)\.$/.exec(raw);
  if (m?.[1] !== undefined) return m[1];
  // `.5` → `0.5`.
  const m2 = /^\.(\d+)$/.exec(raw);
  if (m2?.[1] !== undefined) return `0.${m2[1]}`;
  return '0';
}

/** Sum payment amounts as a decimal string; malformed entries contribute 0. */
function sumPayments(payments: readonly PaymentEntry[]): string {
  let total = new Decimal(0);
  for (const p of payments) {
    const normalized = normalizeDecimalForMath(p.amount);
    try {
      total = total.plus(new Decimal(normalized));
    } catch {
      // skip malformed entries — finalize gating already disables submit
    }
  }
  return total.toString();
}

/** Compute remaining balance = max(grandTotal - sum(payments), 0). */
function computeRemainingBalance(
  grandTotal: string,
  payments: readonly PaymentEntry[],
): string {
  try {
    const balance = new Decimal(grandTotal).minus(new Decimal(sumPayments(payments)));
    return balance.lessThan(0) ? '0' : balance.toString();
  } catch {
    return grandTotal;
  }
}

/**
 * Two decimal strings are "equal as money" iff `Decimal.equals` agrees.
 * Used to gate the finalize button on `sum(payments) === grandTotal`
 * regardless of textual representation (`'10.50'` and `'10.5'`).
 */
function decimalsEqual(a: string, b: string): boolean {
  try {
    return new Decimal(a).equals(new Decimal(b));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ID generators (stable React keys)
// ---------------------------------------------------------------------------

/**
 * Build a monotonic id factory. Pulled out so cart-row ids and payment-row
 * ids are independent counters; mid-cart removals don't shift sibling
 * keys (`'cart-3'` keeps its identity even if `'cart-2'` is removed).
 */
function makeIdFactory(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${String(counter)}`;
  };
}

// ---------------------------------------------------------------------------
// Validation-error banner shape
// ---------------------------------------------------------------------------

/**
 * Read structured details out of a `VALIDATION` envelope. Returns the
 * field name plus the optional `expected`/`actual` decimal strings that
 * `pos.service#finalizeSale` attaches to totals-identity failures so
 * the banner can render "expected X, got Y" alongside the field name.
 */
function readValidationDetails(error: ErrorEnvelope | null): {
  readonly field: string | null;
  readonly expected: string | null;
  readonly actual: string | null;
} {
  if (error?.code !== 'VALIDATION' || error.details === undefined) {
    return { field: null, expected: null, actual: null };
  }
  const details = error.details as {
    field?: unknown;
    expected?: unknown;
    actual?: unknown;
  };
  return {
    field: typeof details.field === 'string' ? details.field : null,
    expected: typeof details.expected === 'string' ? details.expected : null,
    actual: typeof details.actual === 'string' ? details.actual : null,
  };
}

/** Read `productId` off an `OUT_OF_STOCK` envelope. */
function readOutOfStockProductId(error: ErrorEnvelope | null): string | null {
  if (error?.code !== 'OUT_OF_STOCK' || error.details === undefined) {
    return null;
  }
  const productId = (error.details as { productId?: unknown }).productId;
  return typeof productId === 'string' && productId.length > 0 ? productId : null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface POSPageProps {
  /**
   * Optional callback fired after a successful finalize. Receives the
   * persisted sale so a parent (e.g. a future router landing the
   * sales-detail screen, task 13.1) can pivot. The page itself does
   * not navigate.
   */
  readonly onFinalized?: (sale: SaleDTO) => void;
}

export function POSPage({ onFinalized }: POSPageProps = {}): ReactElement {
  const api = useApi();
  const idPrefix = useId();

  // ----- Stable id factories ---------------------------------------------
  const nextCartRowId = useRef(makeIdFactory('cart')).current;
  const nextPaymentRowId = useRef(makeIdFactory('payment')).current;

  // ----- Scanner state ---------------------------------------------------
  const scannerInputRef = useRef<HTMLInputElement | null>(null);
  const [scannerValue, setScannerValue] = useState('');
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  // ----- Cart state ------------------------------------------------------
  const [cart, setCart] = useState<readonly CartLine[]>([]);
  const [outOfStockProductIds, setOutOfStockProductIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  // ----- Discount + customer + payments ---------------------------------
  const [discount, setDiscount] = useState<DiscountInput>({
    kind: 'fixed',
    amount: '0',
  });
  const [customer, setCustomer] = useState<CustomerDTO | null>(null);
  const [payments, setPayments] = useState<readonly PaymentEntry[]>([]);

  // ----- Submission lifecycle -------------------------------------------
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<ErrorEnvelope | null>(null);
  const [success, setSuccess] = useState<SuccessNotice | null>(null);

  // ----- Live totals -----------------------------------------------------
  // Recomputed every render via the shared module. Memoized so a render
  // that doesn't mutate the cart or discount doesn't re-walk the lines.
  // The discount input may carry a mid-typing fragment (`''`, `'0.'`)
  // that the totals module's strict decimal parser rejects; we
  // normalize those to `'0'` so the totals stay numeric while the
  // input element preserves the user's keystrokes.
  const totals = useMemo(() => {
    const items: readonly TotalsItem[] = cart.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.product.sellPrice,
      taxRate: line.product.taxRate,
    }));
    const wireDiscount: DiscountInput =
      discount.kind === 'fixed'
        ? { kind: 'fixed', amount: normalizeDecimalForMath(discount.amount) }
        : { kind: 'percent', percent: normalizeDecimalForMath(discount.percent) };
    let subtotal = '0';
    let discountAmount = '0';
    let taxTotal = '0';
    let grandTotal = '0';
    try {
      subtotal = computeSubtotal(items);
      discountAmount = applyDiscount(subtotal, wireDiscount);
      taxTotal = computeTaxTotal(items, subtotal, discountAmount);
      grandTotal = computeGrandTotal(subtotal, discountAmount, taxTotal);
    } catch {
      // Defensive: malformed cart data would throw here. The cart is
      // built from product DTOs the server vouches for, so this is an
      // unreachable safety net.
    }
    return { subtotal, discountAmount, taxTotal, grandTotal, wireDiscount };
  }, [cart, discount]);

  const remainingBalance = useMemo(
    () => computeRemainingBalance(totals.grandTotal, payments),
    [totals.grandTotal, payments],
  );

  // ----- Re-focus helper -------------------------------------------------
  // Centralizes the "scanner input keeps focus by default and re-focuses
  // after every action" requirement. Wrapped in a callback so it stays
  // referentially stable for the action handlers and the scan effect.
  const refocusScanner = useCallback((): void => {
    // Defer one tick so focus survives the React commit that owns
    // whichever button or input the user just interacted with.
    queueMicrotask(() => {
      scannerInputRef.current?.focus();
    });
  }, []);

  // Initial focus + every commit re-focus.
  useEffect(() => {
    scannerInputRef.current?.focus();
  }, []);

  // ----- Scanner: scan-on-Enter + scan-on-settle -------------------------
  const performScan = useCallback(
    async (rawBarcode: string): Promise<void> => {
      const barcode = rawBarcode.trim();
      if (barcode.length === 0) return;

      const result = await api['pos:scan']({ barcode });
      if (!result.ok) {
        // The service returns Err('VALIDATION', { field: 'barcode' })
        // for empty input — we trim above so that path is unreachable
        // here. Other envelopes are surfaced through the toast layer
        // (`INTERNAL`/`UNAUTHENTICATED`); we still clear the input so
        // the cashier can try again.
        setScannerValue('');
        refocusScanner();
        return;
      }

      const product = result.value;
      if (product === null) {
        setScanMessage(`No product with barcode ${barcode}`);
        setScannerValue('');
        refocusScanner();
        return;
      }

      setScanMessage(null);
      // Append (or increment) into the cart.
      setCart((prev) => {
        const existing = prev.findIndex((line) => line.product.id === product.id);
        if (existing >= 0) {
          return prev.map((line, i) =>
            i === existing ? { ...line, quantity: line.quantity + 1 } : line,
          );
        }
        return [...prev, { rowId: nextCartRowId(), product, quantity: 1 }];
      });
      // Mark out-of-stock if the product's denormalized on-hand is
      // already non-positive. The server will re-check at finalize
      // time but flagging early stops the cashier from trying.
      if (product.onHand <= 0) {
        setOutOfStockProductIds((prev) => {
          const next = new Set(prev);
          next.add(product.id);
          return next;
        });
      }
      setServerError(null);
      setSuccess(null);
      setScannerValue('');
      refocusScanner();
    },
    [api, nextCartRowId, refocusScanner],
  );

  // Settle-delay auto-submit. Fires after the scanner input has been
  // idle for `SCANNER_SETTLE_DELAY_MS` AND the value matches the
  // common alphanumeric barcode shape. Enter still wins on its own —
  // pressing Enter resets the timer and triggers `performScan`
  // synchronously.
  useEffect(() => {
    const trimmed = scannerValue.trim();
    if (trimmed.length < SCANNER_MIN_BARCODE_LENGTH) return undefined;
    if (!/^[a-zA-Z0-9]+$/.test(trimmed)) return undefined;
    const handle = setTimeout(() => {
      void performScan(trimmed);
    }, SCANNER_SETTLE_DELAY_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [scannerValue, performScan]);

  const handleScannerSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      void performScan(scannerValue);
    },
    [performScan, scannerValue],
  );

  // ----- Cart mutations --------------------------------------------------
  const removeCartLine = useCallback((rowId: string): void => {
    setCart((prev) => {
      const next = prev.filter((line) => line.rowId !== rowId);
      // Drop OOS marks for products no longer in the cart.
      setOutOfStockProductIds((prevSet) => {
        const remaining = new Set<string>();
        for (const line of next) {
          if (prevSet.has(line.product.id)) {
            remaining.add(line.product.id);
          }
        }
        return remaining;
      });
      return next;
    });
    setServerError(null);
    setSuccess(null);
    refocusScanner();
  }, [refocusScanner]);

  const setLineQuantity = useCallback(
    (rowId: string, raw: string): void => {
      // Accept any text so the input can render mid-edit; clamp to
      // integer ≥ 1 when a parse succeeds. Empty string keeps the
      // field editable but the canSubmit gate rejects it below.
      const parsed = /^\d+$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : NaN;
      setCart((prev) =>
        prev.map((line) => {
          if (line.rowId !== rowId) return line;
          if (!Number.isInteger(parsed) || parsed < 1) {
            return { ...line, quantity: 0 }; // 0 invalidates the line
          }
          return { ...line, quantity: parsed };
        }),
      );
      // Clear OOS for the affected line's product so the cashier can
      // see whether their adjustment fixes it on the next finalize.
      const targetLine = cart.find((line) => line.rowId === rowId);
      if (targetLine !== undefined) {
        setOutOfStockProductIds((prev) => {
          if (!prev.has(targetLine.product.id)) return prev;
          const next = new Set(prev);
          next.delete(targetLine.product.id);
          return next;
        });
      }
      setServerError(null);
      setSuccess(null);
    },
    [cart],
  );

  // ----- Discount mutations ---------------------------------------------
  const setDiscountKind = useCallback((kind: 'fixed' | 'percent'): void => {
    setDiscount(
      kind === 'fixed' ? { kind: 'fixed', amount: '0' } : { kind: 'percent', percent: '0' },
    );
    setServerError(null);
    refocusScanner();
  }, [refocusScanner]);

  const setDiscountAmount = useCallback((raw: string): void => {
    setDiscount((prev) => {
      const previous = prev.kind === 'fixed' ? prev.amount : '0';
      return { kind: 'fixed', amount: sanitizeDecimalInput(raw, previous) };
    });
    setServerError(null);
  }, []);

  const setDiscountPercent = useCallback((raw: string): void => {
    // The wire format is a ratio (`'0.10'` for 10%); the input is also
    // a ratio so the cashier can enter `'0.1'` for 10%. A percent-only
    // input would be more humane long-term but matches the wire shape
    // for now.
    setDiscount((prev) => {
      const previous = prev.kind === 'percent' ? prev.percent : '0';
      return { kind: 'percent', percent: sanitizeDecimalInput(raw, previous) };
    });
    setServerError(null);
  }, []);

  // ----- Customer attach ------------------------------------------------
  const [customerQuery, setCustomerQuery] = useState('');
  const [debouncedCustomerQuery, setDebouncedCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState<readonly CustomerDTO[]>(
    [],
  );
  const [isSearchingCustomer, setIsSearchingCustomer] = useState(false);

  useEffect(() => {
    if (customerQuery === debouncedCustomerQuery) return undefined;
    const handle = setTimeout(() => {
      setDebouncedCustomerQuery(customerQuery);
    }, CUSTOMER_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [customerQuery, debouncedCustomerQuery]);

  useEffect(() => {
    if (customer !== null) return undefined;
    const trimmed = debouncedCustomerQuery.trim();
    if (trimmed.length === 0) {
      setCustomerResults([]);
      setIsSearchingCustomer(false);
      return undefined;
    }
    let cancelled = false;
    setIsSearchingCustomer(true);
    void (async () => {
      const result = await api['customers:list']({
        search: trimmed,
        pageSize: CUSTOMER_SEARCH_PAGE_SIZE,
      });
      if (cancelled) return;
      setIsSearchingCustomer(false);
      if (result.ok) {
        setCustomerResults(result.value.rows);
      } else {
        setCustomerResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, debouncedCustomerQuery, customer]);

  const selectCustomer = useCallback((picked: CustomerDTO): void => {
    setCustomer(picked);
    setCustomerQuery('');
    setDebouncedCustomerQuery('');
    setCustomerResults([]);
    setServerError(null);
    refocusScanner();
  }, [refocusScanner]);

  const clearCustomer = useCallback((): void => {
    setCustomer(null);
    setServerError(null);
    refocusScanner();
  }, [refocusScanner]);

  // ----- Inline customer create (task 9.3) ------------------------------
  // Cashier-friendly path for capturing a walk-in customer's details
  // mid-checkout. The IPC matrix authorizes `customers:upsert` for
  // both Admin and Cashier per Req 7.2 ("Cashier attaches a customer
  // to a sale"), so this stays inside the role surface — Cashiers
  // can both pick existing customers and add new ones without
  // leaving the POS screen. Errors surface inline below the form
  // (separate from the page-level finalize banner) so a busted
  // create attempt doesn't blow away the cart's error context.
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [creatingCustomerSubmitting, setCreatingCustomerSubmitting] =
    useState(false);
  const [createCustomerError, setCreateCustomerError] =
    useState<ErrorEnvelope | null>(null);

  const openCreateCustomer = useCallback((): void => {
    setCreatingCustomer(true);
    setNewCustomerName('');
    setNewCustomerPhone('');
    setCreateCustomerError(null);
  }, []);

  const cancelCreateCustomer = useCallback((): void => {
    setCreatingCustomer(false);
    setNewCustomerName('');
    setNewCustomerPhone('');
    setCreateCustomerError(null);
    refocusScanner();
  }, [refocusScanner]);

  const submitCreateCustomer = useCallback((): void => {
    const trimmedName = newCustomerName.trim();
    if (trimmedName.length === 0) {
      // Mirror the service's `Err('VALIDATION', { field: 'name' })`
      // shape so the inline error renderer reads exactly the same
      // surface as the server path.
      setCreateCustomerError({
        code: 'VALIDATION',
        message: 'Name is required.',
        details: { field: 'name' },
      });
      return;
    }
    const trimmedPhone = newCustomerPhone.trim();
    setCreatingCustomerSubmitting(true);
    setCreateCustomerError(null);
    void (async () => {
      try {
        const result = await api['customers:upsert']({
          name: trimmedName,
          phone: trimmedPhone === '' ? null : trimmedPhone,
        });
        if (result.ok) {
          // Re-use the existing select path so search state, query
          // input, and result list all reset uniformly.
          selectCustomer(result.value);
          setCreatingCustomer(false);
          setNewCustomerName('');
          setNewCustomerPhone('');
        } else {
          setCreateCustomerError(result.error);
        }
      } finally {
        setCreatingCustomerSubmitting(false);
      }
    })();
  }, [api, newCustomerName, newCustomerPhone, selectCustomer]);

  // ----- Payment mutations ----------------------------------------------
  const addPayment = useCallback(
    (method: PaymentMethod): void => {
      // Pre-fill with the running balance so the common case (one
      // tender for the full amount) is one click away.
      const initialAmount = remainingBalance;
      setPayments((prev) => [
        ...prev,
        { rowId: nextPaymentRowId(), method, amount: initialAmount },
      ]);
      setServerError(null);
      refocusScanner();
    },
    [nextPaymentRowId, refocusScanner, remainingBalance],
  );

  const setPaymentAmount = useCallback((rowId: string, raw: string): void => {
    setPayments((prev) =>
      prev.map((p) => {
        if (p.rowId !== rowId) return p;
        return { ...p, amount: sanitizeDecimalInput(raw, p.amount) };
      }),
    );
    setServerError(null);
  }, []);

  const removePayment = useCallback((rowId: string): void => {
    setPayments((prev) => prev.filter((p) => p.rowId !== rowId));
    setServerError(null);
    refocusScanner();
  }, [refocusScanner]);

  // ----- Finalize gating + submit ---------------------------------------
  const hasAnyOutOfStock = outOfStockProductIds.size > 0;
  const hasInvalidLine = cart.some((line) => line.quantity < 1);
  const paymentsMatchTotal =
    cart.length > 0 && decimalsEqual(sumPayments(payments), totals.grandTotal);
  const canFinalize =
    !submitting &&
    cart.length > 0 &&
    !hasAnyOutOfStock &&
    !hasInvalidLine &&
    paymentsMatchTotal;

  const handleFinalize = useCallback((): void => {
    if (!canFinalize) return;

    const items: readonly SaleItemInput[] = cart.map((line) => ({
      productId: line.product.id,
      quantity: line.quantity,
      unitPrice: line.product.sellPrice,
      taxRate: line.product.taxRate,
      lineTotal: computeLineTotal(line),
    }));

    const wirePayments: readonly PaymentInput[] = payments.map((p) => ({
      method: p.method,
      amount: normalizeDecimalForMath(p.amount),
    }));

    const payload: FinalizeSaleInput = {
      customerId: customer?.id ?? null,
      items,
      discount: totals.wireDiscount,
      subtotal: totals.subtotal,
      discountAmount: totals.discountAmount,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      payments: wirePayments,
    };

    setSubmitting(true);
    setServerError(null);
    setSuccess(null);

    void (async () => {
      try {
        const result = await api['pos:finalize'](payload);
        if (result.ok) {
          // Success: clear the cart, payments, customer attach, and
          // discount. Render the success banner with the serial.
          setCart([]);
          setPayments([]);
          setDiscount({ kind: 'fixed', amount: '0' });
          setCustomer(null);
          setOutOfStockProductIds(new Set());
          setSuccess({
            saleId: result.value.saleId,
            serialNo: result.value.serialNo,
          });
          onFinalized?.(result.value.sale);
          refocusScanner();
          return;
        }
        // Map error envelopes per the task spec.
        const env = result.error;
        if (env.code === 'OUT_OF_STOCK') {
          const productId = readOutOfStockProductId(env);
          if (productId !== null) {
            setOutOfStockProductIds((prev) => {
              const next = new Set(prev);
              next.add(productId);
              return next;
            });
          }
        }
        // All envelopes (including OUT_OF_STOCK) populate the page
        // banner. Cart is preserved on every error path.
        setServerError(env);
      } finally {
        setSubmitting(false);
        refocusScanner();
      }
    })();
  }, [
    api,
    canFinalize,
    cart,
    customer,
    onFinalized,
    payments,
    refocusScanner,
    totals.discountAmount,
    totals.grandTotal,
    totals.subtotal,
    totals.taxTotal,
    totals.wireDiscount,
  ]);

  // ----- Keyboard shortcuts F1–F9 (task 13.5) ---------------------------
  // Per design.md > "Keyboard-first cashier flow":
  //   F1 add product manually   → focus the scanner input
  //   F2 apply discount         → focus the active discount input
  //   F3 attach customer        → focus the customer search input
  //   F4 / F5 / F6 pay cash/card/mobile → seed a payment for the
  //                                       running balance
  //   F9 finalize               → fires `handleFinalize` if `canFinalize`
  // Handlers run only when POSPage is mounted and either no element is
  // focused OR the scanner input is focused (the scanner is the default
  // focus target so the cashier can drive shortcuts while keeping the
  // wedge ready). When focus is in any other input/textarea/select the
  // listener bails out so F-keys do not steal text-edit focus.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      // Ignore modifier-augmented presses so a future `Ctrl+F4` system
      // shortcut on Windows is not accidentally swallowed.
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        return;
      }
      const key = event.key;
      if (
        key !== 'F1' &&
        key !== 'F2' &&
        key !== 'F3' &&
        key !== 'F4' &&
        key !== 'F5' &&
        key !== 'F6' &&
        key !== 'F9'
      ) {
        return;
      }
      const active = document.activeElement;
      const isFormElement =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement;
      const isScanner =
        active instanceof HTMLInputElement &&
        active.getAttribute('data-testid') === 'pos-scanner-input';
      // Suppress shortcuts when any non-scanner input/textarea is
      // focused so the cashier can edit a quantity or a discount field
      // without function keys hijacking focus.
      if (isFormElement && !isScanner) return;

      switch (key) {
        case 'F1': {
          event.preventDefault();
          scannerInputRef.current?.focus();
          scannerInputRef.current?.select();
          return;
        }
        case 'F2': {
          event.preventDefault();
          // Either the fixed-amount or the percent input is mounted at
          // a time depending on the discount kind. Query both so we
          // focus whichever one is currently visible.
          const target = document.querySelector<HTMLInputElement>(
            '[data-testid="pos-discount-amount"], [data-testid="pos-discount-percent"]',
          );
          target?.focus();
          target?.select();
          return;
        }
        case 'F3': {
          event.preventDefault();
          // When a customer is already attached, F3 detaches so the
          // picker is reachable. Otherwise it focuses the existing
          // search input.
          const focusSearch = (): void => {
            // Defer so a state-change-driven re-render has time to
            // mount the search input before we focus it.
            setTimeout(() => {
              const el = document.querySelector<HTMLInputElement>(
                '[data-testid="pos-customer-search"]',
              );
              el?.focus();
            }, 0);
          };
          if (customer !== null) {
            clearCustomer();
          }
          focusSearch();
          return;
        }
        case 'F4': {
          event.preventDefault();
          if (cart.length > 0 && !submitting) addPayment('cash');
          return;
        }
        case 'F5': {
          event.preventDefault();
          if (cart.length > 0 && !submitting) addPayment('card');
          return;
        }
        case 'F6': {
          event.preventDefault();
          if (cart.length > 0 && !submitting) addPayment('mobile');
          return;
        }
        case 'F9': {
          event.preventDefault();
          if (canFinalize) handleFinalize();
          return;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [
    addPayment,
    canFinalize,
    cart.length,
    clearCustomer,
    customer,
    handleFinalize,
    submitting,
  ]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const validationDetails = readValidationDetails(serverError);
  const isFkViolation = serverError !== null && serverError.code === 'FK_VIOLATION';
  const isOutOfStock = serverError !== null && serverError.code === 'OUT_OF_STOCK';

  return (
    <main
      data-testid="pos-page"
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1rem',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 22rem',
        gridTemplateRows: 'auto 1fr auto',
        gridTemplateAreas: `
          "scanner totals"
          "cart    totals"
          "payment totals"
        `,
        columnGap: '1rem',
        rowGap: '0.75rem',
        minHeight: '100vh',
        boxSizing: 'border-box',
      }}
    >
      {/* ============================================================ */}
      {/* Scanner panel (top-left)                                     */}
      {/* ============================================================ */}
      <section style={{ gridArea: 'scanner' }}>
        <form onSubmit={handleScannerSubmit} noValidate>
          <label
            htmlFor={`${idPrefix}-scanner`}
            style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 600 }}
          >
            Scan barcode <span style={{ color: '#777', fontWeight: 400 }}>(F1 to focus)</span>
          </label>
          <input
            ref={scannerInputRef}
            id={`${idPrefix}-scanner`}
            data-testid="pos-scanner-input"
            type="search"
            autoComplete="off"
            placeholder="Scan or type a barcode and press Enter"
            title="Add product manually (F1)"
            value={scannerValue}
            onChange={(e) => {
              setScannerValue(e.target.value);
              setScanMessage(null);
            }}
            style={{
              width: '100%',
              padding: '0.625rem',
              fontSize: '1rem',
              boxSizing: 'border-box',
            }}
          />
          {scanMessage !== null ? (
            <div
              role="status"
              aria-live="polite"
              data-testid="pos-scan-message"
              style={{
                marginTop: '0.25rem',
                color: '#a55',
                fontSize: '0.875rem',
              }}
            >
              {scanMessage}
            </div>
          ) : null}
        </form>
      </section>

      {/* ============================================================ */}
      {/* Cart table (middle-left)                                     */}
      {/* ============================================================ */}
      <section
        style={{
          gridArea: 'cart',
          minHeight: '20rem',
          border: '1px solid #ddd',
          borderRadius: 4,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <CartTableHeader />
        {cart.length === 0 ? (
          <div
            data-testid="pos-cart-empty"
            style={{
              padding: '2rem',
              textAlign: 'center',
              color: '#777',
              flex: 1,
            }}
          >
            Cart is empty. Scan a product to get started.
          </div>
        ) : (
          <div role="rowgroup" style={{ flex: 1, overflowY: 'auto' }}>
            {cart.map((line) => (
              <CartRow
                key={line.rowId}
                line={line}
                outOfStock={outOfStockProductIds.has(line.product.id)}
                onQuantityChange={(value) => {
                  setLineQuantity(line.rowId, value);
                }}
                onRemove={() => {
                  removeCartLine(line.rowId);
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* ============================================================ */}
      {/* Right panel — totals, discount, customer attach              */}
      {/* ============================================================ */}
      <aside
        style={{
          gridArea: 'totals',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          padding: '0.75rem',
          background: '#f7f7f7',
          border: '1px solid #ddd',
          borderRadius: 4,
        }}
      >
        <TotalsPanel
          subtotal={totals.subtotal}
          discountAmount={totals.discountAmount}
          taxTotal={totals.taxTotal}
          grandTotal={totals.grandTotal}
        />
        <DiscountControl
          discount={discount}
          onKindChange={setDiscountKind}
          onAmountChange={setDiscountAmount}
          onPercentChange={setDiscountPercent}
          idPrefix={idPrefix}
        />
        <CustomerAttach
          customer={customer}
          query={customerQuery}
          onQueryChange={setCustomerQuery}
          results={customerResults}
          isSearching={isSearchingCustomer}
          onSelect={selectCustomer}
          onClear={clearCustomer}
          idPrefix={idPrefix}
          creating={creatingCustomer}
          newCustomerName={newCustomerName}
          newCustomerPhone={newCustomerPhone}
          createSubmitting={creatingCustomerSubmitting}
          createError={createCustomerError}
          onOpenCreate={openCreateCustomer}
          onCancelCreate={cancelCreateCustomer}
          onChangeNewName={setNewCustomerName}
          onChangeNewPhone={setNewCustomerPhone}
          onSubmitCreate={submitCreateCustomer}
        />
      </aside>

      {/* ============================================================ */}
      {/* Payment panel (bottom-left, full width up to right column)   */}
      {/* ============================================================ */}
      <section style={{ gridArea: 'payment' }}>
        <PaymentPanel
          payments={payments}
          remainingBalance={remainingBalance}
          grandTotal={totals.grandTotal}
          canFinalize={canFinalize}
          submitting={submitting}
          onAddPayment={addPayment}
          onChangePaymentAmount={setPaymentAmount}
          onRemovePayment={removePayment}
          onFinalize={handleFinalize}
        />

        {/* Server-error banner */}
        {serverError !== null ? (
          <div
            role="alert"
            data-testid="pos-banner-error"
            style={{
              marginTop: '0.75rem',
              padding: '0.75rem',
              border: '1px solid #c33',
              color: '#c33',
              background: '#fff5f5',
              borderRadius: 4,
            }}
          >
            <strong data-testid="pos-banner-error-code">{serverError.code}</strong>
            <div data-testid="pos-banner-error-message">
              {isFkViolation
                ? 'Customer or product not found — please refresh and try again.'
                : isOutOfStock
                  ? 'One or more items are out of stock — please review the cart.'
                  : serverError.message}
            </div>
            {validationDetails.field !== null ? (
              <div
                data-testid="pos-banner-error-field"
                style={{ marginTop: '0.25rem', fontSize: '0.875rem' }}
              >
                Field: <code>{validationDetails.field}</code>
                {validationDetails.expected !== null &&
                validationDetails.actual !== null ? (
                  <>
                    {' '}— expected{' '}
                    <code data-testid="pos-banner-error-expected">
                      {validationDetails.expected}
                    </code>
                    , got{' '}
                    <code data-testid="pos-banner-error-actual">
                      {validationDetails.actual}
                    </code>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Success banner */}
        {success !== null ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="pos-banner-success"
            style={{
              marginTop: '0.75rem',
              padding: '0.75rem',
              border: '1px solid #2a8',
              color: '#1a6',
              background: '#f3fff7',
              borderRadius: 4,
            }}
          >
            <strong>Sale recorded</strong>
            <div>
              Serial:{' '}
              <span data-testid="pos-banner-success-serial">
                {success.serialNo}
              </span>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}


// ===========================================================================
// CartTableHeader / CartRow
// ===========================================================================

function CartTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="pos-cart-header"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 6rem 7rem 5rem 7rem 3rem',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        fontWeight: 600,
        background: '#f7f7f7',
        borderBottom: '1px solid #ddd',
      }}
    >
      <span>Product</span>
      <span style={{ textAlign: 'right' }}>Quantity</span>
      <span style={{ textAlign: 'right' }}>Unit price</span>
      <span style={{ textAlign: 'right' }}>Tax</span>
      <span style={{ textAlign: 'right' }}>Line total</span>
      <span></span>
    </div>
  );
}

interface CartRowProps {
  readonly line: CartLine;
  readonly outOfStock: boolean;
  readonly onQuantityChange: (value: string) => void;
  readonly onRemove: () => void;
}

function CartRow({
  line,
  outOfStock,
  onQuantityChange,
  onRemove,
}: CartRowProps): ReactElement {
  const lineTotal = computeLineTotal(line);
  return (
    <div
      role="row"
      data-testid={`pos-cart-row-${line.product.id}`}
      data-row-id={line.rowId}
      data-out-of-stock={outOfStock ? 'true' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 6rem 7rem 5rem 7rem 3rem',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        minHeight: '56px',
        alignItems: 'center',
        borderBottom: '1px solid #eee',
        background: outOfStock ? '#fff5f5' : undefined,
      }}
    >
      <div>
        <div style={{ fontWeight: 600 }}>{line.product.name}</div>
        <div style={{ color: '#777', fontSize: '0.875rem' }}>
          {line.product.sku}
        </div>
        {outOfStock ? (
          <div
            role="alert"
            data-testid={`pos-cart-row-${line.product.id}-out-of-stock`}
            style={{
              marginTop: '0.25rem',
              color: '#c33',
              fontSize: '0.875rem',
              fontWeight: 600,
            }}
          >
            Out of stock
          </div>
        ) : null}
      </div>
      <input
        data-testid={`pos-cart-row-${line.product.id}-quantity`}
        type="text"
        inputMode="numeric"
        value={line.quantity === 0 ? '' : String(line.quantity)}
        onChange={(e) => {
          onQuantityChange(e.target.value);
        }}
        aria-invalid={line.quantity < 1 ? true : undefined}
        style={{
          padding: '0.5rem',
          textAlign: 'right',
          boxSizing: 'border-box',
          width: '100%',
          borderColor: line.quantity < 1 ? '#c33' : undefined,
        }}
      />
      <div
        data-testid={`pos-cart-row-${line.product.id}-unit-price`}
        style={{
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatMoney(line.product.sellPrice)}
      </div>
      <div
        data-testid={`pos-cart-row-${line.product.id}-tax-rate`}
        style={{
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
          color: '#666',
        }}
      >
        {line.product.taxRate}
      </div>
      <div
        data-testid={`pos-cart-row-${line.product.id}-line-total`}
        style={{
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 600,
        }}
      >
        {formatMoney(lineTotal)}
      </div>
      <button
        type="button"
        onClick={onRemove}
        data-testid={`pos-cart-row-${line.product.id}-remove`}
        aria-label={`Remove ${line.product.name}`}
        style={{ padding: '0.25rem 0.5rem' }}
      >
        ×
      </button>
    </div>
  );
}

// ===========================================================================
// TotalsPanel
// ===========================================================================

interface TotalsPanelProps {
  readonly subtotal: string;
  readonly discountAmount: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
}

function TotalsPanel({
  subtotal,
  discountAmount,
  taxTotal,
  grandTotal,
}: TotalsPanelProps): ReactElement {
  return (
    <div data-testid="pos-totals">
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Totals</h2>
      <TotalsRow label="Subtotal" testId="pos-totals-subtotal" value={subtotal} />
      <TotalsRow
        label="Discount"
        testId="pos-totals-discount"
        value={discountAmount}
      />
      <TotalsRow label="Tax" testId="pos-totals-tax" value={taxTotal} />
      <TotalsRow
        label="Grand total"
        testId="pos-totals-grand"
        value={grandTotal}
        bold
      />
    </div>
  );
}

interface TotalsRowProps {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly bold?: boolean;
}

function TotalsRow({ label, testId, value, bold }: TotalsRowProps): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: '0.5rem',
        padding: '0.25rem 0',
        fontWeight: bold === true ? 700 : 400,
        borderTop: bold === true ? '1px solid #ccc' : undefined,
      }}
    >
      <span>{label}</span>
      <span data-testid={testId} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatMoney(value)}
      </span>
    </div>
  );
}

// ===========================================================================
// DiscountControl
// ===========================================================================

interface DiscountControlProps {
  readonly discount: DiscountInput;
  readonly onKindChange: (kind: 'fixed' | 'percent') => void;
  readonly onAmountChange: (raw: string) => void;
  readonly onPercentChange: (raw: string) => void;
  readonly idPrefix: string;
}

function DiscountControl({
  discount,
  onKindChange,
  onAmountChange,
  onPercentChange,
  idPrefix,
}: DiscountControlProps): ReactElement {
  return (
    <div data-testid="pos-discount-control">
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>
        Discount <span style={{ color: '#777', fontWeight: 400, fontSize: '0.875rem' }}>(F2)</span>
      </h2>
      <div role="radiogroup" aria-label="Discount kind" style={{ marginBottom: '0.5rem' }}>
        <label style={{ marginRight: '0.75rem' }}>
          <input
            data-testid="pos-discount-kind-fixed"
            type="radio"
            name={`${idPrefix}-discount-kind`}
            checked={discount.kind === 'fixed'}
            onChange={() => {
              onKindChange('fixed');
            }}
          />{' '}
          Fixed
        </label>
        <label>
          <input
            data-testid="pos-discount-kind-percent"
            type="radio"
            name={`${idPrefix}-discount-kind`}
            checked={discount.kind === 'percent'}
            onChange={() => {
              onKindChange('percent');
            }}
          />{' '}
          Percent
        </label>
      </div>
      {discount.kind === 'fixed' ? (
        <input
          data-testid="pos-discount-amount"
          type="text"
          inputMode="decimal"
          title="Apply discount (F2)"
          value={discount.amount}
          onChange={(e) => {
            onAmountChange(e.target.value);
          }}
          style={{
            width: '100%',
            padding: '0.5rem',
            boxSizing: 'border-box',
          }}
        />
      ) : (
        <input
          data-testid="pos-discount-percent"
          type="text"
          inputMode="decimal"
          title="Apply discount (F2)"
          value={discount.percent}
          onChange={(e) => {
            onPercentChange(e.target.value);
          }}
          placeholder="0.10 for 10%"
          style={{
            width: '100%',
            padding: '0.5rem',
            boxSizing: 'border-box',
          }}
        />
      )}
    </div>
  );
}

// ===========================================================================
// CustomerAttach
// ===========================================================================

interface CustomerAttachProps {
  readonly customer: CustomerDTO | null;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly results: readonly CustomerDTO[];
  readonly isSearching: boolean;
  readonly onSelect: (customer: CustomerDTO) => void;
  readonly onClear: () => void;
  readonly idPrefix: string;
  // Inline-create form state + handlers (task 9.3). Surfacing the
  // entire form state through props keeps the component pure for
  // unit tests; the parent owns the inputs so a render that
  // succeeded an upsert can re-use the existing `selectCustomer`
  // path to apply the freshly-created row to the cart.
  readonly creating: boolean;
  readonly newCustomerName: string;
  readonly newCustomerPhone: string;
  readonly createSubmitting: boolean;
  readonly createError: ErrorEnvelope | null;
  readonly onOpenCreate: () => void;
  readonly onCancelCreate: () => void;
  readonly onChangeNewName: (next: string) => void;
  readonly onChangeNewPhone: (next: string) => void;
  readonly onSubmitCreate: () => void;
}

function CustomerAttach({
  customer,
  query,
  onQueryChange,
  results,
  isSearching,
  onSelect,
  onClear,
  idPrefix,
  creating,
  newCustomerName,
  newCustomerPhone,
  createSubmitting,
  createError,
  onOpenCreate,
  onCancelCreate,
  onChangeNewName,
  onChangeNewPhone,
  onSubmitCreate,
}: CustomerAttachProps): ReactElement {
  const showResults =
    customer === null && !creating && query.trim().length > 0;
  // Pull the inline-create form's `field` detail off the envelope so
  // the validation message can highlight the offending input.
  const createErrorField =
    createError !== null && createError.code === 'VALIDATION'
      ? readValidationDetails(createError).field
      : null;
  return (
    <div data-testid="pos-customer-attach">
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>
        Customer <span style={{ color: '#777', fontWeight: 400, fontSize: '0.875rem' }}>(F3)</span>
      </h2>
      {customer === null && !creating ? (
        <div>
          <input
            id={`${idPrefix}-customer-search`}
            data-testid="pos-customer-search"
            type="search"
            autoComplete="off"
            placeholder="Search by name (walk-in if blank)"
            title="Attach customer (F3)"
            value={query}
            onChange={(e) => {
              onQueryChange(e.target.value);
            }}
            style={{
              width: '100%',
              padding: '0.5rem',
              boxSizing: 'border-box',
            }}
          />
          <button
            type="button"
            data-testid="pos-customer-new"
            onClick={onOpenCreate}
            style={{
              marginTop: '0.25rem',
              padding: '0.375rem 0.5rem',
              fontSize: '0.875rem',
              background: 'transparent',
              border: '1px dashed #999',
              borderRadius: 4,
              cursor: 'pointer',
              width: '100%',
            }}
          >
            + New customer
          </button>
          {showResults ? (
            <ul
              role="listbox"
              aria-label="Customer search results"
              data-testid="pos-customer-results"
              style={{
                listStyle: 'none',
                margin: '0.25rem 0 0',
                padding: 0,
                border: '1px solid #ddd',
                borderRadius: 4,
                maxHeight: '12rem',
                overflowY: 'auto',
                background: '#fff',
              }}
            >
              {isSearching && results.length === 0 ? (
                <li
                  data-testid="pos-customer-results-loading"
                  style={{ padding: '0.375rem 0.5rem', color: '#777' }}
                >
                  Searching…
                </li>
              ) : null}
              {!isSearching && results.length === 0 ? (
                <li
                  data-testid="pos-customer-results-empty"
                  style={{ padding: '0.375rem 0.5rem', color: '#777' }}
                >
                  No matching customers.
                </li>
              ) : null}
              {results.map((c) => (
                <li key={c.id} role="option" aria-selected="false">
                  <button
                    type="button"
                    data-testid={`pos-customer-result-${c.id}`}
                    onClick={() => {
                      onSelect(c);
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '0.375rem 0.5rem',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: '1px solid #eee',
                      cursor: 'pointer',
                    }}
                  >
                    <strong>{c.name}</strong>
                    {c.phone !== null ? (
                      <span style={{ color: '#777', marginLeft: '0.5rem' }}>
                        {c.phone}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : creating ? (
        <form
          data-testid="pos-customer-new-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmitCreate();
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            padding: '0.5rem',
            border: '1px solid #cde',
            background: '#f3f8ff',
            borderRadius: 4,
          }}
        >
          <label
            htmlFor={`${idPrefix}-new-customer-name`}
            style={{ fontSize: '0.875rem', fontWeight: 600 }}
          >
            Name
          </label>
          <input
            id={`${idPrefix}-new-customer-name`}
            data-testid="pos-customer-new-name"
            type="text"
            autoComplete="off"
            value={newCustomerName}
            onChange={(e) => {
              onChangeNewName(e.target.value);
            }}
            aria-invalid={createErrorField === 'name' ? true : undefined}
            style={{
              padding: '0.5rem',
              boxSizing: 'border-box',
              borderColor: createErrorField === 'name' ? '#c33' : undefined,
            }}
          />
          <label
            htmlFor={`${idPrefix}-new-customer-phone`}
            style={{ fontSize: '0.875rem', fontWeight: 600 }}
          >
            Phone (optional)
          </label>
          <input
            id={`${idPrefix}-new-customer-phone`}
            data-testid="pos-customer-new-phone"
            type="tel"
            autoComplete="off"
            inputMode="tel"
            value={newCustomerPhone}
            onChange={(e) => {
              onChangeNewPhone(e.target.value);
            }}
            aria-invalid={createErrorField === 'phone' ? true : undefined}
            style={{
              padding: '0.5rem',
              boxSizing: 'border-box',
              borderColor: createErrorField === 'phone' ? '#c33' : undefined,
            }}
          />
          {createError !== null ? (
            <div
              role="alert"
              data-testid="pos-customer-new-error"
              style={{
                color: '#c33',
                fontSize: '0.875rem',
                fontWeight: 600,
              }}
            >
              {createError.code === 'VALIDATION' && createErrorField !== null
                ? createError.message
                : createError.code === 'FORBIDDEN'
                  ? 'You do not have permission to add customers.'
                  : createError.message}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="submit"
              data-testid="pos-customer-new-submit"
              disabled={createSubmitting}
              style={{ padding: '0.375rem 0.5rem', flex: 1 }}
            >
              {createSubmitting ? 'Creating…' : 'Create & attach'}
            </button>
            <button
              type="button"
              data-testid="pos-customer-new-cancel"
              onClick={onCancelCreate}
              disabled={createSubmitting}
              style={{ padding: '0.375rem 0.5rem' }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : customer !== null ? (
        <div
          data-testid="pos-customer-selected"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.5rem',
            padding: '0.5rem 0.75rem',
            border: '1px solid #cde',
            background: '#f3f8ff',
            borderRadius: 4,
          }}
        >
          <div>
            <strong data-testid="pos-customer-selected-name">{customer.name}</strong>
            {customer.phone !== null ? (
              <div style={{ color: '#555', fontSize: '0.875rem' }}>
                {customer.phone}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClear}
            data-testid="pos-customer-clear"
            style={{ padding: '0.25rem 0.5rem' }}
          >
            Change
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ===========================================================================
// PaymentPanel
// ===========================================================================

interface PaymentPanelProps {
  readonly payments: readonly PaymentEntry[];
  readonly remainingBalance: string;
  readonly grandTotal: string;
  readonly canFinalize: boolean;
  readonly submitting: boolean;
  readonly onAddPayment: (method: PaymentMethod) => void;
  readonly onChangePaymentAmount: (rowId: string, raw: string) => void;
  readonly onRemovePayment: (rowId: string) => void;
  readonly onFinalize: () => void;
}

function PaymentPanel({
  payments,
  remainingBalance,
  grandTotal,
  canFinalize,
  submitting,
  onAddPayment,
  onChangePaymentAmount,
  onRemovePayment,
  onFinalize,
}: PaymentPanelProps): ReactElement {
  return (
    <div
      data-testid="pos-payment-panel"
      style={{
        padding: '0.75rem',
        background: '#fafafa',
        border: '1px solid #ddd',
        borderRadius: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          marginBottom: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        {PAYMENT_METHODS.map((method) => (
          <button
            key={method}
            type="button"
            data-testid={`pos-payment-add-${method}`}
            title={PAYMENT_SHORTCUT_HINT[method]}
            onClick={() => {
              onAddPayment(method);
            }}
            style={{
              minHeight: '80px',
              minWidth: '8rem',
              padding: '0.75rem 1.25rem',
              fontSize: '1.125rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {PAYMENT_LABEL[method]}
          </button>
        ))}
      </div>

      {payments.length > 0 ? (
        <ul
          data-testid="pos-payment-list"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            marginBottom: '0.75rem',
          }}
        >
          {payments.map((p) => (
            <li
              key={p.rowId}
              data-testid={`pos-payment-row-${p.rowId}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '6rem 1fr 3rem',
                gap: '0.5rem',
                alignItems: 'center',
                padding: '0.25rem 0',
              }}
            >
              <span style={{ fontWeight: 600 }}>{PAYMENT_LABEL[p.method]}</span>
              <input
                data-testid={`pos-payment-row-${p.rowId}-amount`}
                type="text"
                inputMode="decimal"
                value={p.amount}
                onChange={(e) => {
                  onChangePaymentAmount(p.rowId, e.target.value);
                }}
                style={{
                  padding: '0.5rem',
                  textAlign: 'right',
                  boxSizing: 'border-box',
                  fontVariantNumeric: 'tabular-nums',
                }}
              />
              <button
                type="button"
                data-testid={`pos-payment-row-${p.rowId}-remove`}
                aria-label="Remove payment"
                onClick={() => {
                  onRemovePayment(p.rowId);
                }}
                style={{ padding: '0.25rem 0.5rem' }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          marginTop: '0.5rem',
        }}
      >
        <div>
          <div style={{ color: '#555' }}>Grand total</div>
          <div
            data-testid="pos-payment-grand-total"
            style={{
              fontWeight: 700,
              fontSize: '1.25rem',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatMoney(grandTotal)}
          </div>
        </div>
        <div>
          <div style={{ color: '#555' }}>Remaining</div>
          <div
            data-testid="pos-payment-remaining"
            style={{
              fontWeight: 700,
              fontSize: '1.25rem',
              fontVariantNumeric: 'tabular-nums',
              color: decimalsEqual(remainingBalance, '0') ? '#1a6' : '#c33',
            }}
          >
            {formatMoney(remainingBalance)}
          </div>
        </div>
        <button
          type="button"
          data-testid="pos-finalize"
          title="Finalize sale (F9)"
          disabled={!canFinalize}
          onClick={onFinalize}
          style={{
            minHeight: '80px',
            minWidth: '12rem',
            padding: '1rem 1.5rem',
            fontSize: '1.25rem',
            fontWeight: 700,
            cursor: canFinalize ? 'pointer' : 'not-allowed',
            background: canFinalize ? '#2a8' : '#ccc',
            color: canFinalize ? '#fff' : '#666',
            border: 'none',
            borderRadius: 4,
          }}
        >
          {submitting ? 'Finalizing…' : 'Finalize sale'}
        </button>
      </div>
    </div>
  );
}
