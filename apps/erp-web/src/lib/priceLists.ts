import type { PriceList } from './apiTypes';

/**
 * Phase 14 — reading price-list CONFIGURATION, never resolving a price.
 *
 * THERE IS NO `resolvePrice()` HERE AND THERE MUST NEVER BE ONE, for the
 * same reason `lib/shiftReview.ts` refuses an `expectedCash()`: the
 * selling price a sale is written at comes from `resolveSellingPrice` on
 * the server, which the POS quote and the sale itself both run. A second
 * implementation in a browser would be free to drift from the number the
 * customer is actually charged.
 *
 * WHAT APPLICABILITY MEANS, EXACTLY. The live `PriceList` model carries
 * two booleans and nothing else: `isDefault` and `isActive`. The backend's
 * own rule (`loadConfiguredPrices`) is therefore "the one list that is
 * both default AND active". There is no customer-, branch- or
 * warehouse-scoped price list in the schema, and this milestone does not
 * invent one — that remains an open owner decision.
 */

/**
 * The list the backend will actually price from, or null when the tenant
 * has none.
 *
 * This MIRRORS `loadConfiguredPrices`, it does not replace it: knowing
 * which list is in force is what lets the ERP say "prices here are the
 * ones the tills will charge" instead of leaving a manager to guess. No
 * price is read or compared.
 */
export function applicablePriceList(lists: PriceList[]): PriceList | null {
  return lists.find((l) => l.isDefault && l.isActive) ?? null;
}

/**
 * How one list stands relative to the shop's pricing.
 *
 *   APPLICABLE  — default and active: the tills price from this one.
 *   INERT       — default but DEACTIVATED. This is the case worth naming:
 *                 the tenant has a default list that no longer applies, so
 *                 every sale falls back to whatever price the till sends.
 *                 A manager who cannot see that would believe prices are
 *                 being enforced when they are not.
 *   INACTIVE    — not default, and switched off.
 *   STANDBY     — active, but not the default, so nothing prices from it.
 */
export type PriceListRole = 'APPLICABLE' | 'INERT' | 'INACTIVE' | 'STANDBY';

export function priceListRole(list: PriceList): PriceListRole {
  if (list.isDefault) return list.isActive ? 'APPLICABLE' : 'INERT';
  return list.isActive ? 'STANDBY' : 'INACTIVE';
}

export function priceListTone(role: PriceListRole): 'success' | 'warning' | 'neutral' {
  if (role === 'APPLICABLE') return 'success';
  if (role === 'INERT') return 'warning';
  return 'neutral';
}

/**
 * Whether promoting this list to default would change which prices the
 * tills charge. Used only to decide how loudly to confirm; the server
 * demotes the previous default either way.
 */
export function promotionChangesPricing(list: PriceList, lists: PriceList[]): boolean {
  if (list.isDefault) return false;
  const current = applicablePriceList(lists);
  return current === null || current.id !== list.id;
}
