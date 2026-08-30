/**
 * Timezone arithmetic against a tenant's own `Business.timezone`.
 *
 * Extracted from Phase 7's `reporting/domain/date-range.ts` (behaviour
 * unchanged, still covered by its own tests) so that Phase 8D's promotion
 * validity windows resolve calendar dates through the SAME implementation
 * a report does. Two copies of timezone maths would be exactly the
 * duplicate source of truth this codebase avoids everywhere else, and
 * would eventually disagree about a DST boundary.
 *
 * Uses `Intl` rather than a date library - none is a dependency of this
 * project.
 */

/** The UTC instant corresponding to 00:00:00 on `date`'s calendar day AS
 * SEEN IN `timezone`. */
export function startOfDayInZone(date: Date, timezone: string): Date {
  const { year, month, day } = zonedParts(date, timezone);
  // Guess the UTC instant for local midnight, then correct by the actual
  // offset at that instant (handles zones whose offset differs between
  // the original instant and midnight, e.g. across a DST transition).
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  return new Date(guess.getTime() - offsetAt(guess, timezone));
}

export function startOfMonthInZone(date: Date, timezone: string): Date {
  const { year, month } = zonedParts(date, timezone);
  const guess = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  return new Date(guess.getTime() - offsetAt(guess, timezone));
}

/**
 * A `YYYY-MM-DD` calendar date to the UTC instant of its local midnight
 * in `timezone`. `dayOffset` shifts by whole days first, so an inclusive
 * end date becomes the EXCLUSIVE instant at the start of the next day -
 * the half-open convention used for both report ranges and promotion
 * validity windows.
 */
export function calendarDateToInstant(calendarDate: string, timezone: string, dayOffset = 0): Date {
  const [year, month, day] = calendarDate.split('-').map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day + dayOffset, 0, 0, 0, 0));
  return new Date(guess.getTime() - offsetAt(guess, timezone));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number } {
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
export function offsetAt(instant: Date, timezone: string): number {
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
