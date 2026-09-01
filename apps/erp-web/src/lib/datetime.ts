/**
 * Phase 13 (ERP foundation) — one way to print a date, chosen deliberately.
 *
 * WHY NOT `toLocaleString()` WITH NO ARGUMENT, which is what the screens
 * used first. That follows the BROWSER's locale, not the app's, so the
 * same shift rendered `9/1/2026, 10:32:02 AM` under an Arabic UI: a
 * US-ambiguous day/month (is that 9 January or 1 September?) plus an AM/PM
 * token that the RTL bidi algorithm reorders to the visually wrong end of
 * the string. A date a manager is signing off on must not be ambiguous.
 *
 * WHY A FIXED FORMAT RATHER THAN THE ACTIVE LANGUAGE. `money.ts` already
 * pins its digits to `en-US` on purpose, so figures read the same in both
 * languages; formatting dates per-language would give Arabic-Indic digits
 * beside Western-digit money in the same table row, and could switch the
 * calendar underneath a business whose books are Gregorian. So the calendar
 * and the digits stay fixed and the LABELS around them are translated,
 * which is the same bargain money makes.
 *
 * `en-GB` is the vehicle for day-first, 24-hour, zero-padded output
 * (`01/09/2026, 10:32`) — not a statement about locale. There is no AM/PM
 * token left to reorder, so the string is stable under RTL.
 *
 * TIMES ARE SHOWN IN THE VIEWER'S OWN ZONE, which is what a manager
 * reconciling this morning's drawer expects. The server remains
 * authoritative for anything a DATE decides — warranty coverage is
 * `effectiveStatus`, computed from snapshotted dates server-side, never
 * from a comparison made here.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DATE_ONLY = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** An instant: `01/09/2026, 10:32`. Empty string for a missing value, so a
 *  caller can render it without a conditional and never prints "Invalid
 *  Date" at a user. */
export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  // The comma `en-GB` puts between date and time is bidi-neutral, so RTL
  // floats it to the far end of the string (`10:36 ,01/09/2026`). A space
  // says the same thing and has no direction to get wrong.
  return DATE_TIME.format(d).replace(', ', ' ');
}

/** A calendar day: `01/09/2026`. Used where a time would be noise — a
 *  warranty's cover window, for instance. */
export function formatDate(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? DATE_ONLY.format(d) : '';
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
