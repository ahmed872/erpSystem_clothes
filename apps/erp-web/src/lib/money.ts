/**
 * Every money value that crosses the API boundary is a decimal-as-string
 * (see apiTypes.ts). This module is the ONLY place that parses one for
 * display or turns a UI number back into a request field — it never
 * recomputes a total, a tax, a discount, or anything else the backend is
 * authoritative for (Phase 12 rule: no pricing/tax/promotion/loyalty engine
 * in the browser). `previewLineTotal` below is explicitly a client-side
 * ESTIMATE for the cart screen, shown before checkout; the server response
 * from `POST /sales` is what actually gets displayed as the real total.
 */

export function parseMoney(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function formatMoney(value: string | number | null | undefined, currency = ''): string {
  const n = parseMoney(value);
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

/** A client-side ESTIMATE only, for the cart preview before the server's
 * authoritative totals come back on the created Sale / its receipt. Does
 * NOT apply tax, promotions, or loyalty — those are computed exclusively
 * server-side. */
export function previewLineTotal(unitPrice: number, quantity: number, discountAmount: number): number {
  return Math.max(0, unitPrice * quantity - discountAmount);
}
