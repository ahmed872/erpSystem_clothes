import { Prisma } from '@prisma/client';

/**
 * The system's monetary scale. Every money column in the schema is
 * `Decimal(18, 4)`, so 4 is not an arbitrary choice - it is the precision
 * the database itself stores, and rounding anywhere else would mean a
 * value that silently changes when it is written.
 */
export const MONEY_SCALE = 4;

/**
 * Rounds a monetary value to 4 decimal places, HALF-UP (approved
 * decision BD-6).
 *
 * Phases 1-8B contained NO rounding call of any kind - every amount was
 * built from Decimal arithmetic and left to the column's own scale on
 * write. This is therefore the first explicit rounding policy in the
 * codebase, introduced at exactly the scale the columns already use so
 * that it changes no existing value. It is applied in precisely three
 * places (see the Phase 8C design): the loyalty redemption value, each
 * line's allocated share of it, and each line's cumulative return credit.
 *
 * HALF-UP, never floor: floor is the approved rule for POINTS (BD-3),
 * because a customer should never be credited a point they have not
 * fully earned. Money is different - flooring a refund or a discount
 * would quietly shortchange the customer on every transaction.
 */
export function round4(value: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Truncates DOWN to 4 decimal places. Used only for the provisional
 * shares in the largest-remainder allocation, where every share must
 * start at or below its exact value so the leftover can be distributed
 * deterministically rather than appearing as a shortfall that has
 * already been rounded away.
 */
export function floor4(value: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_FLOOR);
}

/** One unit at the monetary scale - the step size for remainder distribution. */
export const MONEY_STEP = new Prisma.Decimal(1).dividedBy(new Prisma.Decimal(10).pow(MONEY_SCALE));
