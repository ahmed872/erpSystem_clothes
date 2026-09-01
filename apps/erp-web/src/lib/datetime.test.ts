import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from './datetime';

/**
 * Phase 13 (ERP foundation).
 *
 * These lock the two properties that made a fixed format necessary: the
 * day comes before the month (so `01/09/2026` cannot be misread as
 * 9 January), and there is no AM/PM token for the RTL bidi algorithm to
 * reorder to the wrong end of the string.
 */

// Fixed to the environment's zone so the assertions describe the FORMAT,
// not the offset — the value below is midday, far from any date boundary.
const NOON = '2026-09-01T12:00:00.000Z';

describe('formatDateTime', () => {
  it('puts the day first and pads it, so a date cannot be misread', () => {
    expect(formatDateTime(NOON)).toMatch(/^01\/09\/2026 \d{2}:\d{2}$/);
  });

  it('uses a 24-hour clock — no AM/PM for RTL to reorder', () => {
    expect(formatDateTime(NOON)).not.toMatch(/AM|PM/i);
  });

  it('carries no bidi-neutral comma that RTL could float to the wrong end', () => {
    expect(formatDateTime(NOON)).not.toContain(',');
  });

  it('accepts a Date as readily as the wire string', () => {
    expect(formatDateTime(new Date(NOON))).toBe(formatDateTime(NOON));
  });

  it('renders nothing — never "Invalid Date" — for an absent or broken value', () => {
    // Every caller passes a nullable server field straight in, so this is
    // what stops a null `reconciledAt` printing at a manager.
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime('')).toBe('');
    expect(formatDateTime('not a date')).toBe('');
  });
});

describe('formatDate', () => {
  it('is the calendar day alone, with no time', () => {
    expect(formatDate(NOON)).toBe('01/09/2026');
  });

  it('is also empty for an absent value', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('nope')).toBe('');
  });
});

describe('the format is stable across the app language', () => {
  it('does not switch calendar or digits — money is Western-digit too', () => {
    // The bargain this module makes: labels are translated, the calendar
    // and the digits are not. Arabic-Indic digits beside Western-digit
    // money in one table row would be worse than either alone.
    expect(formatDate(NOON)).toMatch(/^[0-9/]+$/);
    expect(formatDateTime(NOON)).toMatch(/^[0-9/: ]+$/);
  });
});
