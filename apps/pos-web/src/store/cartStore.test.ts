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
});
