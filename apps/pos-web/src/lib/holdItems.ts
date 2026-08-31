import type { CartLine } from '../store/cartStore';
import type { HeldSale, HeldSaleItem, SaleItemInput } from './apiTypes';
import { parseMoney } from './money';

/**
 * Phase 12 (Held Sales) — the pure, testable half of parking and picking
 * up a basket.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no pricing here, and there is no
 * total that anyone is invited to trust. A hold stores INPUTS — variant,
 * quantity, unit price, manual discount, serials — and nothing else,
 * because tax, promotions and loyalty are resolved by the server at
 * CHECKOUT against the configuration in force then. `indicativeValue`
 * below exists purely so a cashier can tell two parked baskets apart on a
 * list; it is the same arithmetic the cart screen already labels as an
 * estimate, and the authoritative figure only ever comes from
 * `POST /sales/quote` once the basket is resumed.
 */

/** The cart, in the shape `POST /sales/holds` accepts — identical to the
 * shape the quote and the sale accept, because a hold is a stored sale
 * REQUEST and nothing more. */
export function holdItemsFromCart(lines: CartLine[]): SaleItemInput[] {
  return lines.map((l) => ({
    variantId: l.variantId,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discountAmount: l.discountAmount,
    // Serials are INTENDED units, not consumed ones. The server validates
    // them at checkout under the unchanged BD-13 rules and never at hold
    // time — a unit scanned into a parked basket stays sellable to
    // everyone else, which is exactly what makes the hold soft.
    serials: l.tracksSerialNumbers && l.serials.length > 0 ? l.serials : undefined,
  }));
}

/** How many physical units are sitting in the parked basket. */
export function holdUnitCount(items: HeldSaleItem[]): number {
  return items.reduce((sum, i) => sum + parseMoney(i.quantity), 0);
}

/**
 * An INDICATION of what the basket was worth when it was parked — never a
 * price, a quote, or a promise. No tax, no promotion, no loyalty: those
 * belong to a sale that does not exist yet. Shown only so a cashier can
 * recognise their own basket in a list.
 */
export function indicativeValue(items: HeldSaleItem[]): number {
  return items.reduce(
    (sum, i) => sum + Math.max(0, parseMoney(i.unitPrice) * parseMoney(i.quantity) - parseMoney(i.discountAmount)),
    0,
  );
}

/**
 * Whether the cart in front of the cashier still IS the parked basket.
 *
 * This decides one thing: whether resuming needs to save the edits first.
 * `POST /sales/holds/:id/resume` sells the lines the SERVER has stored, not
 * the lines on screen — so a cashier who added a serial or changed a
 * quantity after picking the basket up must have that written back with
 * `PATCH /sales/holds/:id` before the resume, or their change is silently
 * ignored. Comparing by value (not identity) keeps a redundant PATCH off
 * the wire for the common case where nothing was touched.
 */
export function basketMatchesHold(hold: HeldSale, lines: CartLine[]): boolean {
  if (hold.items.length !== lines.length) return false;
  const byVariant = new Map(hold.items.map((i) => [i.variantId, i]));
  return lines.every((line) => {
    const stored = byVariant.get(line.variantId);
    if (!stored) return false;
    return (
      parseMoney(stored.quantity) === line.quantity &&
      parseMoney(stored.unitPrice) === line.unitPrice &&
      parseMoney(stored.discountAmount) === line.discountAmount &&
      sameSerials(stored.serials, line.serials)
    );
  });
}

function sameSerials(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * A basket is ready to be parked when it has something in it. Serials are
 * NOT required here and that is the point: a cashier parks a basket to get
 * the customer out of the queue, and the units can be scanned when the
 * basket is picked up. The serial rule is enforced where it belongs — at
 * checkout, by the server.
 */
export function canHold(lines: CartLine[]): boolean {
  return lines.length > 0;
}
