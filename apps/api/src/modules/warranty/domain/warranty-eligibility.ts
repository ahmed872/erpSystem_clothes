/**
 * Coverage is evaluated purely from the warranty's OWN snapshotted dates
 * (`startDate`/`endDate`, themselves derived once from the snapshotted
 * `durationDays`). Current configuration is never consulted, so changing
 * `Setting['warranty.default_duration_days']` can never widen or narrow
 * an already-issued warranty's coverage.
 *
 * The interval is half-open `[startDate, endDate)` - the same convention
 * Phase 7's reporting date ranges use, so a boundary instant belongs to
 * exactly one side and coverage can neither gap nor double-count.
 */
export interface WarrantyCoverageDates {
  startDate: Date;
  endDate: Date;
}

export function isWarrantyCoverageActive(warranty: WarrantyCoverageDates, at: Date): boolean {
  return at.getTime() >= warranty.startDate.getTime() && at.getTime() < warranty.endDate.getTime();
}

/**
 * The status a warranty would present as *right now*, derived from its
 * own dates. `VOID` and `CLAIMED` are explicit stored states set by a
 * human action and always win over a date-derived value; only the
 * ACTIVE/EXPIRED distinction is time-dependent.
 *
 * This is a DERIVED read-model value, deliberately NOT written back to
 * the row by any scheduled process - Phase 8A adds no job runner
 * (approved scope decision). A warranty whose period has elapsed still
 * has `status = ACTIVE` stored; `effectiveStatus` is what callers should
 * read for "is it still in date".
 */
export function effectiveWarrantyStatus(
  warranty: WarrantyCoverageDates & { status: 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'VOID' },
  at: Date,
): 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'VOID' {
  if (warranty.status === 'VOID') return 'VOID';
  if (at.getTime() >= warranty.endDate.getTime()) return 'EXPIRED';
  return warranty.status;
}
