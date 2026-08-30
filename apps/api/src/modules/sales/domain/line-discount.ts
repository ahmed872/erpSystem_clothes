import { Prisma } from '@prisma/client';

/**
 * Approved decision BD-12: a manual discount may NEVER exceed the line's
 * own gross, so a line's net merchandise value can never be negative.
 *
 * ---------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `discountAmount` arrives as a plain non-negative money value with no
 * upper bound, and the only database guard is
 * `sale_items_line_total_nonneg` (`gross - discount + tax >= 0`). With any
 * tax on the line, that permits a discount LARGER than the gross - e.g.
 * gross 100, discount 110, tax 20 stores a line_total of 10 quite
 * happily.
 *
 * Before Phase 8C that was merely odd. After the BD-1 correction it is
 * harmful: `merchandiseValue = gross - discount` goes NEGATIVE, so the
 * cumulative return credit goes negative, the customer is silently
 * credited nothing when they return the goods, the revenue reversal is
 * skipped, and the loyalty clawback and restoration both clamp to zero.
 * The customer hands back the item and receives neither money nor points.
 *
 * Capping here makes the invariant `finalDiscount <= lineGross` true
 * UNIVERSALLY, which is the same rule already approved for a manual
 * discount combined with a promotion (BD-11) - now generalised so it also
 * holds on lines no promotion ever reached.
 *
 * ---------------------------------------------------------------------
 * BLAST RADIUS
 *
 * For every well-formed sale this is the identity: a discount at or below
 * the gross is returned unchanged. It only bites on a line that was
 * already malformed, and there it replaces silent value destruction with
 * a coherent zero-merchandise line.
 */
export function capManualDiscount(manualDiscount: Prisma.Decimal.Value, lineGross: Prisma.Decimal): Prisma.Decimal {
  return Prisma.Decimal.min(new Prisma.Decimal(manualDiscount), lineGross);
}
