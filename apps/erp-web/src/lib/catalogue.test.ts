import { describe, expect, it } from 'vitest';
import * as catalogue from './catalogue';
import {
  bundleComponents,
  canEditBundle,
  DEACTIVATED_STATUS,
  hasCost,
  pageWindow,
  primaryBarcode,
  productTone,
  variantHasCost,
  variantAttributes,
  variantLabel,
  variantTone,
} from './catalogue';
import type { BundleItem, ProductStatus, Variant } from './apiTypes';

/**
 * Phase 14.
 *
 * Two properties matter more than any individual case and are asserted
 * directly: this module resolves no price, and it offers no delete. The
 * first is D3's rule (the server decides the selling price); the second
 * is the live contract's (there is no DELETE route on a product, so the
 * ERP deactivates and never invents delete semantics).
 */

function variant(over: Partial<Variant> = {}): Variant {
  return {
    id: 'v1',
    productId: 'p1',
    sku: 'JKT-001',
    status: 'ACTIVE',
    sellingPrice: '1200',
    weight: null,
    barcodes: [],
    attributeValues: [],
    ...over,
  };
}

function attr(name: string, value: string) {
  return { attributeValue: { id: `${name}-${value}`, attributeId: name, value, sortOrder: 0, attribute: { id: name, name } } };
}

describe('the module boundary', () => {
  it('resolves no price — the server decides what a line sells for', () => {
    for (const name of Object.keys(catalogue)) {
      expect(name).not.toMatch(/resolvePrice|calculatePrice|applicablePrice/i);
    }
  });

  it('offers no delete: the catalogue contract deactivates', () => {
    // `products.delete` exists as a permission code and is granted to two
    // role templates, but NO live route consults it — there is no DELETE
    // on a product or a variant anywhere in the catalogue module.
    expect(catalogue.CATALOGUE_DELETE_IS_DEACTIVATION).toBe(true);
    for (const name of Object.keys(catalogue)) {
      expect(name).not.toMatch(/^delete/i);
    }
  });

  it('deactivates to INACTIVE, never to DISCONTINUED', () => {
    // Both exist and mean different things to a merchant — withdrawn for
    // now versus never coming back. The UI offers the reversible one and
    // leaves the other to an explicit status change; guessing between
    // them would be inventing policy.
    expect(DEACTIVATED_STATUS).toBe('INACTIVE');
  });
});

describe('productTone', () => {
  it('maps each status and invents no meaning', () => {
    const cases: [ProductStatus, string][] = [
      ['ACTIVE', 'success'],
      ['INACTIVE', 'neutral'],
      ['DISCONTINUED', 'danger'],
    ];
    for (const [status, tone] of cases) expect(productTone(status)).toBe(tone);
  });

  it('distinguishes a withdrawn product from a discontinued one', () => {
    expect(productTone('INACTIVE')).not.toBe(productTone('DISCONTINUED'));
  });
});

describe('variantTone', () => {
  it('has only the two states the variant contract has', () => {
    expect(variantTone('ACTIVE')).toBe('success');
    expect(variantTone('INACTIVE')).toBe('neutral');
  });
});

describe('cost visibility', () => {
  it('asks whether cost ARRIVED, never whether the user holds a grant', () => {
    // The server DELETES the key for a caller without products.view_cost —
    // on write responses as well as reads. A screen that asked about the
    // permission instead would be a branch someone could flip.
    expect(hasCost({ defaultCost: '400' })).toBe(true);
    expect(hasCost({})).toBe(false);
    expect(variantHasCost(variant({ cost: '400' }))).toBe(true);
    expect(variantHasCost(variant())).toBe(false);
  });

  it('treats a zero cost as present — 0 is a figure, not an absence', () => {
    expect(hasCost({ defaultCost: '0' })).toBe(true);
    expect(variantHasCost(variant({ cost: '0' }))).toBe(true);
  });
});

describe('variantLabel', () => {
  it('reads whatever dimensions the TENANT defined, in order', () => {
    // Generic on purpose: "Large / Red" for a garment, "12kg / 220V" for a
    // washing machine. Nothing here knows what a size is.
    expect(variantLabel(variant({ attributeValues: [attr('Size', 'Large'), attr('Colour', 'Red')] }))).toBe('Large / Red');
    expect(variantLabel(variant({ attributeValues: [attr('Capacity', '12kg'), attr('Voltage', '220V')] }))).toBe('12kg / 220V');
  });

  it('falls back to the SKU for the auto-generated variant of a simple product', () => {
    // A bundle row needs SOMETHING to name a component with.
    expect(variantLabel(variant({ attributeValues: [] }))).toBe('JKT-001');
  });
});

describe('variantAttributes', () => {
  it('is null — not the SKU — when a variant has no attributes', () => {
    // The variant table already has a SKU column beside this one, and
    // printing the same string twice reads as a bug.
    expect(variantAttributes(variant({ attributeValues: [] }))).toBeNull();
  });

  it('is the values themselves when there are some', () => {
    expect(variantAttributes(variant({ attributeValues: [attr('Size', 'Large')] }))).toBe('Large');
  });
});

describe('primaryBarcode', () => {
  it('prefers the one marked primary', () => {
    const v = variant({
      barcodes: [
        { id: 'b1', variantId: 'v1', code: '111', isPrimary: false },
        { id: 'b2', variantId: 'v1', code: '222', isPrimary: true },
      ],
    });
    expect(primaryBarcode(v)).toBe('222');
  });

  it('falls back to the first when none is marked, and is null with none at all', () => {
    expect(primaryBarcode(variant({ barcodes: [{ id: 'b1', variantId: 'v1', code: '111', isPrimary: false }] }))).toBe('111');
    expect(primaryBarcode(variant())).toBeNull();
  });
});

describe('canEditBundle', () => {
  it('offers composition editing ONLY for a BUNDLE, which the server enforces', () => {
    // PUT /catalog/products/:id/bundle-items refuses a non-BUNDLE with a
    // 422, so offering the control on a SIMPLE product would hand a user
    // an action that must fail.
    expect(canEditBundle({ type: 'BUNDLE' })).toBe(true);
    expect(canEditBundle({ type: 'SIMPLE' })).toBe(false);
  });
});

describe('bundleComponents', () => {
  it('flattens what the server sent and computes no consumption', () => {
    // What selling one bundle takes out of stock is InventoryEngineService,
    // server-side, and explicitly untouched by this milestone.
    const items = [
      {
        bundleProductId: 'p1',
        componentVariantId: 'v9',
        quantity: '2',
        componentVariant: { ...variant({ id: 'v9', sku: 'TSHIRT-1' }), product: { id: 'p9', name: 'T-Shirt', sku: 'TS' } },
      },
    ] as unknown as BundleItem[];
    expect(bundleComponents(items)).toEqual([{ variantId: 'v9', sku: 'TSHIRT-1', name: 'T-Shirt', quantity: '2' }]);
  });

  it('is empty for a bundle with nothing in it yet', () => {
    expect(bundleComponents([])).toEqual([]);
  });
});

describe('pageWindow', () => {
  it('centres on the current page in the middle of a long list', () => {
    expect(pageWindow(10, 20)).toEqual([8, 9, 10, 11, 12]);
  });

  it('does not run past either end', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(20, 20)).toEqual([16, 17, 18, 19, 20]);
  });

  it('shows every page when there are few', () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(2, 2)).toEqual([1, 2]);
    expect(pageWindow(1, 1)).toEqual([1]);
  });
});
