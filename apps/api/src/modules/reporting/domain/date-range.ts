import { TenantTx } from '../../../common/prisma/prisma.service';
import { ValidationFailedError } from '../../../common/errors/domain-error';

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

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The UTC instant corresponding to 00:00:00 on `date`'s calendar day AS
 * SEEN IN `timezone`. Uses Intl rather than a date library (none is a
 * dependency of this project) - `formatToParts` gives the zone-local
 * calendar fields, and the offset between that wall-clock reading and the
 * original instant is what converts the local midnight back to UTC.
 */
function startOfDayInZone(date: Date, timezone: string): Date {
  const { year, month, day } = zonedParts(date, timezone);
  // Guess the UTC instant for local midnight, then correct by the actual
  // offset at that instant (handles zones whose offset differs between
  // the original instant and midnight, e.g. across a DST transition).
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const offsetMs = offsetAt(guess, timezone);
  return new Date(guess.getTime() - offsetMs);
}

function startOfMonthInZone(date: Date, timezone: string): Date {
  const { year, month } = zonedParts(date, timezone);
  const guess = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const offsetMs = offsetAt(guess, timezone);
  return new Date(guess.getTime() - offsetMs);
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The zone's UTC offset, in ms, at the given instant. */
function offsetAt(instant: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - instant.getTime();
}
