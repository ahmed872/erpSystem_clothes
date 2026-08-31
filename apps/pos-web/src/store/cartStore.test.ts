import { describe, expect, it, beforeEach } from 'vitest';
import { useCartStore } from './cartStore';
import type { ProductVariant } from '../lib/apiTypes';

function makeVariant(overrides: Partial<ProductVariant> = {}): ProductVariant {
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
      tracksSerialNumbers: false,
      taxExempt: false,
      category: null,
      brand: null,
    },
    attributeValues: [
      { attributeId: 'attr-1', attributeValueId: 'val-1', attributeValue: { id: 'val-1', attributeId: 'attr-1', value: 'M', attribute: { id: 'attr-1', name: 'Size' } } },
    ],
    barcodes: [],
    ...overrides,
  };
}

describe('cartStore', () => {
  beforeEach(() => {
    useCartStore.getState().clear();
  });

  it('adding the same variant twice increments quantity rather than duplicating the line', () => {
    const variant = makeVariant();
    useCartStore.getState().addVariant(variant, 45);
    useCartStore.getState().addVariant(variant, 45);
    const { lines } = useCartStore.getState();
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(2);
  });

  it('reducing quantity to zero removes the line', () => {
    const variant = makeVariant();
    useCartStore.getState().addVariant(variant, 45);
    const key = useCartStore.getState().lines[0].key;
    useCartStore.getState().updateQuantity(key, 0);
    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it('shrinking quantity trims any already-captured serials to match', () => {
    const variant = makeVariant({ product: { ...makeVariant().product, tracksSerialNumbers: true } });
    useCartStore.getState().addVariant(variant, 45);
    const key = useCartStore.getState().lines[0].key;
    useCartStore.getState().updateQuantity(key, 3);
    useCartStore.getState().setSerials(key, ['SN-1', 'SN-2', 'SN-3']);
    useCartStore.getState().updateQuantity(key, 1);
    expect(useCartStore.getState().lines[0].serials).toEqual(['SN-1']);
  });

  it('a discount can never go negative', () => {
    const variant = makeVariant();
    useCartStore.getState().addVariant(variant, 45);
    const key = useCartStore.getState().lines[0].key;
    useCartStore.getState().updateDiscount(key, -10);
    expect(useCartStore.getState().lines[0].discountAmount).toBe(0);
  });

  // ---------------------------------------------- Phase 12: held sales ----
  const parkedLine = {
    key: 'variant-9',
    variantId: 'variant-9',
    sku: 'SKU-9',
    productName: 'Parked coat',
    variantLabel: 'Blue',
    tracksSerialNumbers: false,
    unitPrice: 80,
    quantity: 2,
    discountAmount: 0,
    serials: [],
  };

  it('a fresh cart is not resuming anything', () => {
    expect(useCartStore.getState().resuming).toBeNull();
  });

  it('loading a parked basket REPLACES the cart rather than merging into it', () => {
    // Merging someone else's parked basket into a half-built one would
    // sell goods nobody asked for.
    useCartStore.getState().addVariant(makeVariant(), 45);
    useCartStore.getState().loadHold({ id: 'h1', holdNumber: 'HOLD-ABCD1234', label: 'blue coat lady' }, [parkedLine], null);

    const state = useCartStore.getState();
    expect(state.lines).toEqual([parkedLine]);
    expect(state.resuming).toEqual({ id: 'h1', holdNumber: 'HOLD-ABCD1234', label: 'blue coat lady' });
  });

  it('a resumed basket starts with no loyalty redemption — points are spent against the sale being made now', () => {
    useCartStore.getState().setRedeemPoints(50);
    useCartStore.getState().loadHold({ id: 'h1', holdNumber: 'HOLD-ABCD1234', label: null }, [parkedLine], null);
    expect(useCartStore.getState().redeemPoints).toBe(0);
  });

  it('clearing the cart also puts the basket back — the till must not still think it is holding one', () => {
    useCartStore.getState().loadHold({ id: 'h1', holdNumber: 'HOLD-ABCD1234', label: null }, [parkedLine], null);
    useCartStore.getState().clear();
    expect(useCartStore.getState().resuming).toBeNull();
    expect(useCartStore.getState().lines).toHaveLength(0);
  });
});
