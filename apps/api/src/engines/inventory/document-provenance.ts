import { StockMovementType } from '@prisma/client';
import { ValidationFailedError } from '../../common/errors/domain-error';

/**
 * Phase 22 (P21-2) — A MOVEMENT THAT NAMES A DOCUMENT MUST NAME *THE*
 * DOCUMENT.
 *
 * WHAT WAS WRONG. The generic stock primitives default to a document
 * type and left the reference optional, so
 * `POST /inventory/receipts {warehouseId, variantId, quantity, unitCost}`
 * wrote a movement of type PURCHASE with `referenceType: null,
 * referenceId: null` — a row claiming to have come from a purchase
 * document while naming no purchase. The same hole existed on the
 * consume side, where the default is SALE.
 *
 * WHY IT IS NOT COSMETIC. Provenance is load-bearing in three separate
 * places, and a provenance-less row is silently wrong in all of them:
 *
 *   1. A sale return recovers its cost basis by looking the original
 *      movement up BY provenance (`referenceType: 'Sale', referenceId:
 *      saleId`), and refuses the return outright if it cannot find one.
 *   2. COGS on the dashboard and the sales summary is summed over
 *      movements filtered by `referenceType: 'Sale'`. A SALE movement
 *      with no reference is excluded — so gross profit silently
 *      OVERSTATES by exactly the cost of whatever was consumed that way.
 *   3. The inventory-GL reconciliation excludes rows by `referenceType`,
 *      so its "zero tolerance" verdict is computed over a set that
 *      quietly disagrees with the ledger.
 *
 * THE RULE. The four types that name a business document must carry one.
 * Everything else is unchanged: OPENING_BALANCE has no document by
 * definition, the adjustment family (ADJUSTMENT, DAMAGE, LOSS,
 * INTERNAL_CONSUMPTION, EXPIRY) keeps its existing reason-based
 * contract, and the transfer and bundle types already supply their own
 * references without being asked to.
 *
 * WHERE IT IS ENFORCED. Here, inside the engine, on the single path that
 * writes a movement row — so it holds for every caller including any
 * future one, not only for the two request schemas that also check it.
 * The schema layer gives a caller a clear 422 at the edge; this is the
 * guarantee behind it.
 *
 * NOT DONE, DELIBERATELY: no movement type renamed, no enum migration,
 * no second source of truth, and no fabricated provenance for historical
 * rows — pre-existing movements are left exactly as they are, because
 * inventing a reference for them would be worse than an honest gap.
 */
export const DOCUMENT_MOVEMENT_TYPES: readonly StockMovementType[] = [
  'PURCHASE',
  'SALE',
  'SALES_RETURN',
  'PURCHASE_RETURN',
];

export function requiresDocumentProvenance(movementType: StockMovementType): boolean {
  return DOCUMENT_MOVEMENT_TYPES.includes(movementType);
}

/**
 * Throws unless a document-typed movement carries both halves of its
 * origin. Both are required together: a `referenceType` with no
 * `referenceId` names a kind of document rather than a document, which
 * is no more traceable than naming nothing.
 */
export function assertDocumentProvenance(params: {
  movementType: StockMovementType;
  referenceType?: string | null;
  referenceId?: string | null;
}): void {
  if (!requiresDocumentProvenance(params.movementType)) return;

  const missing: string[] = [];
  if (!params.referenceType?.trim()) missing.push('referenceType');
  if (!params.referenceId?.trim()) missing.push('referenceId');
  if (missing.length === 0) return;

  throw new ValidationFailedError(
    `A ${params.movementType} movement must identify the document it came from`,
    { movementType: params.movementType, missing: missing.join(', ') },
  );
}
