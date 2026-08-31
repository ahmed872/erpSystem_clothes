import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney, previewLineTotal } from './money';

describe('parseMoney', () => {
  it('parses a decimal-as-string from the API', () => {
    expect(parseMoney('93.0000')).toBe(93);
  });
  it('treats null/undefined as zero', () => {
    expect(parseMoney(null)).toBe(0);
    expect(parseMoney(undefined)).toBe(0);
  });
  it('treats a non-numeric string as zero rather than NaN', () => {
    expect(parseMoney('not-a-number')).toBe(0);
  });
});

describe('formatMoney', () => {
  it('formats to two decimal places', () => {
    expect(formatMoney('93')).toBe('93.00');
    expect(formatMoney(93.456)).toBe('93.46');
  });
  it('appends a currency suffix when given one', () => {
    expect(formatMoney('10', 'SAR')).toBe('10.00 SAR');
  });
});

describe('previewLineTotal', () => {
  it('is quantity times price, minus the line discount — an ESTIMATE, never authoritative', () => {
    expect(previewLineTotal(45, 2, 5)).toBe(85);
  });
  it('never goes negative even if the discount exceeds the line value', () => {
    expect(previewLineTotal(10, 1, 50)).toBe(0);
  });
});
