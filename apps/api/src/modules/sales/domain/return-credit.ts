import { Prisma } from '@prisma/client';
import { round4 } from '../../../common/domain/money';

/**
 * THE single definition of "what a returned unit is worth" (approved
 * decision BD-1). Three consumers share it and none may define its own:
 *   1. the SaleReturn refund / customer credit,
 *   2. the loyalty return clawback,
 *   3. the loyalty redemption restoration.
 *
 * ---------------------------------------------------------------------
 * WHY THE OLD CALCULATION WAS WRONG
 *
 * Phase 5 credited `quantity x unitPrice`, ignoring `discountAmount`
 * entirely. On a Buy-2-Get-1 line (quantity 3, unitPrice 100,
 * discountAmount 100) the customer paid 200 but returning all three
 * units one at a time refunded 300. Any discounted line had the same
 * defect; promotions and loyalty redemption would have made it routine.
 *
 * ---------------------------------------------------------------------
 * WHY `SaleItem.lineTotal` CANNOT BE USED
 *
 * The stored `lineTotal` is `unitPrice x quantity - discount + tax` - it
 * INCLUDES tax. BD-1's `lineTotal` is a different quantity (merchandise
 * only), so the merchandise value must be derived from the parts, never
 * read from that column. Refunding the stored value would refund tax as
 * merchandise and corrupt both the credit and every loyalty figure
 * derived from it.
 *
 * ---------------------------------------------------------------------
 * WHY THE CREDIT IS CUMULATIVE RATHER THAN PER-RETURN
 *
 * The naive form `returnedQty x (merchandiseValue / quantity)` does not
 * add up. For the Buy-2-Get-1 line above, `200 / 3 = 66.6667` (4 dp) and
 * three single-unit returns refund `200.0001` - more than the line was
 * ever worth. Rounding each return independently accumulates error.
 *
 * Instead every return is a DIFFERENCE OF CUMULATIVE VALUES:
 *
 *     cumulativeCredit(q) = round4(merchandiseValue x q / quantity)
 *     thisReturnCredit    = cumulativeCredit(after) - cumulativeCredit(before)
 *
 * This is exact by construction: at `q = quantity` the expression is
 * `round4(merchandiseValue)`, which is the value itself, so the deltas
 * telescope to exactly the merchandise value however the returns are
 * split. The same cumulative-delta shape is used for loyalty clawback
 * and restoration, so all three stay consistent with one another.
 */

export interface ReturnCreditLine {
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  quantityReturned: Prisma.Decimal;
}

/**
 * The line's total merchandise value: what the customer actually paid
 * for the goods, after every discount and EXCLUDING tax.
 *
 * The gross is rounded to the monetary scale before the discount is
 * subtracted, which matters for fractional quantities (weighted goods):
 * it makes `SUM(merchandiseValue)` equal the Sale's own
 * `subtotal - discountAmount` exactly, which is what lets a full return
 * claw back and restore loyalty exactly. `CreateSaleUseCase` rounds each
 * line's gross the same way when it builds `subtotal`, so the two agree
 * by construction. For integer quantities the rounding is the identity,
 * so no pre-existing sale's arithmetic changes.
 */
export function lineMerchandiseValue(line: ReturnCreditLine): Prisma.Decimal {
  return round4(line.unitPrice.times(line.quantity)).minus(line.discountAmount);
}

/** `round4(merchandiseValue x q / quantity)` - the credit owed once a
 * cumulative `q` units of this line have been returned. */
export function cumulativeLineCredit(line: ReturnCreditLine, cumulativeQuantity: Prisma.Decimal.Value): Prisma.Decimal {
  const q = new Prisma.Decimal(cumulativeQuantity);
  if (q.lessThanOrEqualTo(0)) return new Prisma.Decimal(0);
  const merchandiseValue = lineMerchandiseValue(line);
  if (q.greaterThanOrEqualTo(line.quantity)) return round4(merchandiseValue);
  return round4(merchandiseValue.times(q).dividedBy(line.quantity));
}

/**
 * The credit for returning `quantityNow` more units of a line that has
 * already had `line.quantityReturned` units returned - the difference of
 * the two cumulative values, never a fresh proportional multiplication.
 */
export function lineReturnCredit(line: ReturnCreditLine, quantityNow: Prisma.Decimal.Value): Prisma.Decimal {
  const before = cumulativeLineCredit(line, line.quantityReturned);
  const after = cumulativeLineCredit(line, line.quantityReturned.plus(quantityNow));
  return after.minus(before);
}

/**
 * The whole sale's cumulative return credit, given each line's
 * cumulative returned quantity. This is the `C` the loyalty clawback and
 * restoration formulas consume; on a fully returned sale it equals the
 * sale's own `subtotal - discountAmount` exactly.
 */
export function saleCumulativeReturnCredit(lines: ReturnCreditLine[]): Prisma.Decimal {
  return lines.reduce((sum, line) => sum.plus(cumulativeLineCredit(line, line.quantityReturned)), new Prisma.Decimal(0));
}
