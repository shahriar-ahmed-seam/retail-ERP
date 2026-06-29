/*
 * Locale-aware formatting helpers. Money is always shown in Bangladeshi
 * Taka with the ৳ symbol; digits stay Western for register clarity.
 */

import Decimal from 'decimal.js';

const TAKA = '৳';

export function formatMoney(value: string | number): string {
  let dec: Decimal;
  try {
    dec = new Decimal(value);
  } catch {
    dec = new Decimal(0);
  }
  const fixed = dec.toFixed(2);
  const [whole, frac] = fixed.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${TAKA} ${grouped}.${frac ?? '00'}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
