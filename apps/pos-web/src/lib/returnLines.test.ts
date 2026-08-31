import { describe, expect, it } from 'vitest';
import { canPreview, draftFromReceipt, lineIsReady, selectedLines, toRequestItems } from './returnLines';
import type { SaleReceipt } from './apiTypes';

function receiptWith(items: Partial<SaleReceipt['items'][number]>[]): SaleReceipt {
  return {
    items: items.map((i, n) => ({
      id: `item-${n}`,
      sku: `SKU-${n}`,
      name: `Product ${n}`,
      alternativeName: null,
      quantity: '1',
      unitPrice: '10',
      discountAmount: '0',
      taxAmount: '0',
      taxRatePercent: null,
      taxExempt: false,
      lineTotal: '10',
      quantityReturned: '0',
      serials: [],
      ...i,
    })),
  } as SaleReceipt;
}

describe('return line drafting (form mechanics only — never money)', () => {
  it('reads names, SKUs and quantities from the receipt, not from a UUID', () => {
    const [line] = draftFromReceipt(receiptWith([{ name: 'Linen Shirt', sku: 'SHIRT-M', quantity: '3' }]));
    expect(line.name).toBe('Linen Shirt');
    expect(line.sku).toBe('SHIRT-M');
    expect(line.quantitySold).toBe(3);
  });

  it('subtracts what is already back, and defaults to returning the rest', () => {
    const [line] = draftFromReceipt(receiptWith([{ quantity: '5', quantityReturned: '2' }]));
    expect(line.availableToReturn).toBe(3);
    expect(line.quantity).toBe(3);
  });

  it('a fully returned line offers nothing', () => {
    const [line] = draftFromReceipt(receiptWith([{ quantity: '2', quantityReturned: '2' }]));
    expect(line.availableToReturn).toBe(0);
    expect(lineIsReady({ ...line, selected: true })).toBe(false);
  });

  it('a line that left with serials requires them coming back', () => {
    const [line] = draftFromReceipt(receiptWith([{ quantity: '2', serials: ['A', 'B'] }]));
    expect(line.requiresSerials).toBe(true);
    expect(line.soldSerials).toEqual(['A', 'B']);
    expect(lineIsReady({ ...line, selected: true })).toBe(false);
    expect(lineIsReady({ ...line, selected: true, serials: ['A'] })).toBe(false);
    expect(lineIsReady({ ...line, selected: true, serials: ['A', 'B'] })).toBe(true);
  });

  it('rejects the same unit chosen twice', () => {
    const [line] = draftFromReceipt(receiptWith([{ quantity: '2', serials: ['A', 'B'] }]));
    expect(lineIsReady({ ...line, selected: true, serials: ['A', 'A'] })).toBe(false);
  });

  it('a non-serial line never needs serials', () => {
    const [line] = draftFromReceipt(receiptWith([{ quantity: '2' }]));
    expect(line.requiresSerials).toBe(false);
    expect(lineIsReady({ ...line, selected: true })).toBe(true);
  });

  it('refuses more than remains returnable', () => {
    const [line] = draftFromReceipt(receiptWith([{ quantity: '3', quantityReturned: '1' }]));
    expect(lineIsReady({ ...line, selected: true, quantity: 2 })).toBe(true);
    expect(lineIsReady({ ...line, selected: true, quantity: 3 })).toBe(false);
    expect(lineIsReady({ ...line, selected: true, quantity: 0 })).toBe(false);
  });

  it('previewing needs at least one selected, ready line', () => {
    const lines = draftFromReceipt(receiptWith([{ quantity: '2' }, { quantity: '1', serials: ['S1'] }]));
    expect(canPreview(lines)).toBe(false);
    expect(canPreview([{ ...lines[0], selected: true }, lines[1]])).toBe(true);
    // A selected serial line with nothing chosen blocks the whole request.
    expect(canPreview([{ ...lines[0], selected: true }, { ...lines[1], selected: true }])).toBe(false);
    expect(canPreview([{ ...lines[0], selected: true }, { ...lines[1], selected: true, serials: ['S1'] }])).toBe(true);
  });

  it('builds a request carrying serials only where the product tracks them', () => {
    const lines = draftFromReceipt(receiptWith([{ quantity: '2' }, { quantity: '1', serials: ['S1'] }]));
    const body = toRequestItems([
      { ...lines[0], selected: true, quantity: 2, condition: 'DAMAGED' },
      { ...lines[1], selected: true, quantity: 1, serials: ['S1'] },
    ]);
    expect(body).toEqual([
      { saleItemId: 'item-0', quantity: 2, condition: 'DAMAGED' },
      { saleItemId: 'item-1', quantity: 1, condition: 'SELLABLE', serials: ['S1'] },
    ]);
    expect(body[0]).not.toHaveProperty('serials');
  });

  it('only selected lines reach the request', () => {
    const lines = draftFromReceipt(receiptWith([{ quantity: '2' }, { quantity: '2' }]));
    expect(selectedLines([{ ...lines[0], selected: true }, lines[1]])).toHaveLength(1);
    expect(toRequestItems([{ ...lines[0], selected: true }, lines[1]])).toHaveLength(1);
  });
});
