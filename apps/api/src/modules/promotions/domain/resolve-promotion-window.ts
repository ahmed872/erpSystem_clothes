import { TenantTx } from '../../../common/prisma/prisma.service';
import { ValidationFailedError, NotFoundDomainError } from '../../../common/errors/domain-error';
import { calendarDateToInstant } from '../../../common/domain/business-timezone';
import { PromotionTargetType } from '@prisma/client';

/**
 * Turns a caller's `YYYY-MM-DD` pair into the stored half-open
 * `[validFrom, validTo)` instants, interpreted in the BUSINESS's own
 * timezone - the same helper Phase 7 reporting uses, not a second copy.
 *
 * `validTo` is INCLUSIVE as the caller writes it and EXCLUSIVE as stored:
 * `validTo = 2026-01-31` becomes the instant at the start of 1 February
 * local time, so the whole final day is covered exactly once. An
 * inclusive stored bound would either drop everything after local
 * midnight on the last day or need a fragile 23:59:59.999 sentinel.
 *
 * Why the wire format is a calendar date rather than an instant: only the
 * server knows the business timezone, so accepting an instant would let a
 * caller in another zone silently shift when a promotion starts and ends.
 */
export async function resolvePromotionWindow(
  tx: TenantTx,
  businessId: string,
  validFrom: string,
  validTo: string,
): Promise<{ validFrom: Date; validTo: Date; timezone: string }> {
  const business = await tx.business.findFirstOrThrow({ where: { id: businessId }, select: { timezone: true } });
  const from = calendarDateToInstant(validFrom, business.timezone);
  // +1 day => the exclusive instant at the start of the following day.
  const to = calendarDateToInstant(validTo, business.timezone, 1);

  if (to.getTime() <= from.getTime()) {
    throw new ValidationFailedError('`validTo` must not be before `validFrom`', { validFrom, validTo });
  }
  return { validFrom: from, validTo: to, timezone: business.timezone };
}

/**
 * Proves the promotion's target actually exists INSIDE the caller's own
 * tenant before the rule is written. `targetId` is deliberately not a
 * foreign key - one column cannot reference three tables - so this is the
 * check that stops a promotion pointing at another business's product or
 * at nothing at all.
 */
export async function assertPromotionTargetExists(
  tx: TenantTx,
  businessId: string,
  targetType: PromotionTargetType,
  targetId: string,
): Promise<void> {
  const found =
    targetType === 'PRODUCT'
      ? await tx.product.findFirst({ where: { id: targetId, businessId }, select: { id: true } })
      : targetType === 'VARIANT'
        ? await tx.productVariant.findFirst({ where: { id: targetId, businessId }, select: { id: true } })
        : await tx.category.findFirst({ where: { id: targetId, businessId }, select: { id: true } });

  if (!found) {
    throw new NotFoundDomainError(
      targetType === 'PRODUCT' ? 'Product' : targetType === 'VARIANT' ? 'ProductVariant' : 'Category',
      targetId,
    );
  }
}
