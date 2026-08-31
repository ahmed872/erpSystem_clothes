import { describe, expect, it } from 'vitest';
import {
  addNewItemDraft,
  canBuildExchange,
  newItemIsReady,
  removeNewItemDraft,
  setNewItemSerials,
  toNewItemsRequest,
  updateNewItemPrice,
  updateNewItemQuantity,
  type NewItemDraft,
} from './exchangeItems';
import type { ProductVariant } from './apiTypes';

function variant(overrides: Partial<ProductVariant> = {}, tracksSerialNumbers = false): ProductVariant {
  return {
    id: 'variant-1',
    productId: 'product-1',
    sku: 'SKU-1',
    status: 'ACTIVE',
    sellingPrice: '45',
    product: {
      id: 'product-1',
      sku: 'SKU-1',
      name: 'Test Product',
      alternativeName: null,
      type: 'SIMPLE',
      status: 'ACTIVE',
      defaultSellingPrice: '45',
      tracksSerialNumbers,
      taxExempt: false,
      category: null,
      brand: null,
    },
    attributeValues: [
      {
        attributeId: 'attr-1',
        attributeValueId: 'val-1',
        attributeValue: { id: 'val-1', attributeId: 'attr-1', value: 'L', attribute: { id: 'attr-1', name: 'Size' } },
      },
    ],
    barcodes: [],
    ...overrides,
  };
}

describe('addNewItemDraft', () => {
  it('adds a line carrying the variant label and the shelf price it was given', () => {
    const [line] = addNewItemDraft([], variant(), 45);
    expect(line).toMatchObject({ variantId: 'variant-1', sku: 'SKU-1', variantLabel: 'L', unitPrice: 45, quantity: 1 });
  });

  it('merges a repeat of the same variant into one line instead of duplicating it', () => {
    const once = addNewItemDraft([], variant(), 45);
    const twice = addNewItemDraft(once, variant(), 45);
    expect(twice).toHaveLength(1);
    expect(twice[0].quantity).toBe(2);
  });

  it('keeps distinct variants as separate lines', () => {
    const first = addNewItemDraft([], variant(), 45);
    const both = addNewItemDraft(first, variant({ id: 'variant-2', sku: 'SKU-2' }), 60);
    expect(both).toHaveLength(2);
  });
});

describe('updateNewItemQuantity', () => {
  it('removes the line when the quantity reaches zero', () => {
    const drafts = addNewItemDraft([], variant(), 45);
    expect(updateNewItemQuantity(drafts, 'variant-1', 0)).toEqual([]);
  });

  it('trims already-captured serials when the quantity shrinks', () => {
    let drafts = addNewItemDraft([], variant({}, true), 45);
    drafts = updateNewItemQuantity(drafts, 'variant-1', 3);
    drafts = setNewItemSerials(drafts, 'variant-1', ['A', 'B', 'C']);
    drafts = updateNewItemQuantity(drafts, 'variant-1', 1);
    expect(drafts[0].serials).toEqual(['A']);
  });
});

describe('updateNewItemPrice', () => {
  it('never allows a negative price', () => {
    const drafts = updateNewItemPrice(addNewItemDraft([], variant(), 45), 'variant-1', -10);
    expect(drafts[0].unitPrice).toBe(0);
  });
});

describe('removeNewItemDraft', () => {
  it('drops only the named line', () => {
    let drafts = addNewItemDraft([], variant(), 45);
    drafts = addNewItemDraft(drafts, variant({ id: 'variant-2', sku: 'SKU-2' }), 60);
    expect(removeNewItemDraft(drafts, 'variant-1').map((d) => d.variantId)).toEqual(['variant-2']);
  });
});

describe('newItemIsReady', () => {
  const base: NewItemDraft = {
    key: 'k',
    variantId: 'v',
    sku: 'S',
    variantLabel: '',
    tracksSerialNumbers: false,
    unitPrice: 10,
    quantity: 1,
    serials: [],
  };

  it('a plain line is ready once it has a quantity', () => {
    expect(newItemIsReady(base)).toBe(true);
    expect(newItemIsReady({ ...base, quantity: 0 })).toBe(false);
  });

  it('a serial-tracked line needs exactly as many serials as units', () => {
    const tracked = { ...base, tracksSerialNumbers: true, quantity: 2 };
    expect(newItemIsReady(tracked)).toBe(false);
    expect(newItemIsReady({ ...tracked, serials: ['A'] })).toBe(false);
    expect(newItemIsReady({ ...tracked, serials: ['A', 'B'] })).toBe(true);
  });

  it('rejects duplicate serials — two units cannot be the same unit', () => {
    const tracked = { ...base, tracksSerialNumbers: true, quantity: 2, serials: ['A', 'A'] };
    expect(newItemIsReady(tracked)).toBe(false);
  });
});

describe('canBuildExchange', () => {
  const ready = addNewItemDraft([], variant(), 45);

  it('needs BOTH halves: something coming back and something going out', () => {
    expect(canBuildExchange(false, ready)).toBe(false);
    expect(canBuildExchange(true, [])).toBe(false);
    expect(canBuildExchange(true, ready)).toBe(true);
  });

  it('is false while any replacement line is still missing its serials', () => {
    const unready = addNewItemDraft([], variant({}, true), 45);
    expect(canBuildExchange(true, unready)).toBe(false);
  });
});

describe('toNewItemsRequest', () => {
  it('sends serials only for a serial-tracked line — never an empty array on a plain one', () => {
    const plain = toNewItemsRequest(addNewItemDraft([], variant(), 45));
    expect(plain[0]).toEqual({ variantId: 'variant-1', quantity: 1, unitPrice: 45 });

    const tracked = toNewItemsRequest(setNewItemSerials(addNewItemDraft([], variant({}, true), 45), 'variant-1', ['SN-1']));
    expect(tracked[0]).toEqual({ variantId: 'variant-1', quantity: 1, unitPrice: 45, serials: ['SN-1'] });
  });
});
