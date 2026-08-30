import { TenantTx } from '../../../common/prisma/prisma.service';
import { ValidationFailedError } from '../../../common/errors/domain-error';
import { addDays, startOfDayInZone, startOfMonthInZone } from '../../../common/domain/business-timezone';

export interface ResolvedDateRange {
  /** Inclusive lower bound. */
  from: Date;
  /** EXCLUSIVE upper bound - see the half-open interval note below. */
  toExclusive: Date;
  timezone: string;
}

/**
 * Resolves a caller-supplied `from`/`to` pair into a half-open
 * `[from, toExclusive)` UTC interval, interpreted in the BUSINESS's own
 * timezone rather than raw UTC.
 *
 * Why the business timezone matters: `Business.timezone` defaults to
 * Africa/Cairo. A sale rung up at 22:00 Cairo time on the 31st is
 * 20:00 UTC the same day - but a shop in a UTC+something zone can
 * legitimately have evening sales that fall on the NEXT UTC day. Filtering
 * on raw UTC day boundaries would misattribute those sales to the wrong
 * day, quietly corrupting every daily/monthly total. Resolving the
 * boundary in the tenant's own zone is what makes "sales for January"
 * mean what the shop owner means by it.
 *
 * Why half-open `[from, to)`: an inclusive upper bound would either drop
 * everything after 00:00:00.000 on the end date, or require a fragile
 * "23:59:59.999" sentinel that silently loses sub-millisecond rows. The
 * caller passes an inclusive calendar end date (`to=2026-01-31`) and this
 * helper converts it to the exclusive instant at the START of the next
 * day, so the whole final day is included exactly once, with no gap and
 * no overlap between adjacent periods.
 */
export async function resolveDateRange(tx: TenantTx, businessId: string, from?: Date, to?: Date): Promise<ResolvedDateRange> {
  const business = await tx.business.findFirstOrThrow({ where: { id: businessId }, select: { timezone: true } });
  const timezone = business.timezone;

  const now = new Date();
  // Default window: the current calendar month in the business's own zone.
  const resolvedFrom = from ?? startOfMonthInZone(now, timezone);
  const resolvedToInclusive = to ?? now;

  if (resolvedFrom.getTime() > resolvedToInclusive.getTime()) {
    throw new ValidationFailedError('`from` must not be after `to`', {
      from: resolvedFrom.toISOString(),
      to: resolvedToInclusive.toISOString(),
    });
  }

  return {
    from: startOfDayInZone(resolvedFrom, timezone),
    toExclusive: startOfDayInZone(addDays(resolvedToInclusive, 1), timezone),
    timezone,
  };
}

/** The Prisma filter fragment for a resolved range against a column. */
export function dateRangeWhere(range: ResolvedDateRange): { gte: Date; lt: Date } {
  return { gte: range.from, lt: range.toExclusive };
}
