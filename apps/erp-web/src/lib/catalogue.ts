import type { BundleItem, ProductDetail, ProductListRow, ProductStatus, Variant, VariantStatus } from './apiTypes';

/**
 * Phase 14 — the only catalogue logic in the ERP browser, and it decides
 * nothing the backend decides.
 *
 * THERE IS NO PRICE RESOLUTION HERE, AND THERE MUST NEVER BE ONE. What a
 * line actually sells for is `resolveSellingPrice` on the server, reading
 * the active default price list; a second implementation in a browser
 * would be free to disagree with the figure the sale is actually written
 * at. These helpers read and label what the server already sent.
 */

/**
 * WHETHER A PRODUCT CAN BE DELETED — it cannot, and this states why in
 * one place rather than leaving each screen to discover it.
 *
 * `products.delete` EXISTS as a permission code and is granted to
 * BUSINESS_OWNER and INVENTORY_MANAGER, but NO route in the live backend
 * consults it: there is no DELETE on a product or a variant anywhere in
 * the catalogue module. The contract is deactivation — `status` moves to
 * INACTIVE or DISCONTINUED and the record, its history and every sale
 * that referenced it stay intact.
 *
 * So the ERP offers deactivation and never a delete button. Inventing one
 * would mean inventing delete semantics (cascade? refuse when stock
 * exists? what happens to historical sale lines?) that the owner has
 * explicitly deferred.
 */
export const CATALOGUE_DELETE_IS_DEACTIVATION = true;

/** The three states a product can be in, straight from the server. */
export function productTone(status: ProductStatus): 'success' | 'neutral' | 'danger' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'INACTIVE') return 'neutral';
  return 'danger';
}

export function variantTone(status: VariantStatus): 'success' | 'neutral' {
  return status === 'ACTIVE' ? 'success' : 'neutral';
}

/**
 * Whether this product's cost was sent at all.
 *
 * The server DELETES `defaultCost` (and each variant's `cost`) for a
 * caller without `products.view_cost` — on write responses as well as
 * reads. A screen asks this rather than asking "does the user hold the
 * grant", so there is no client-side branch that could be flipped to
 * reveal a figure the response never carried.
 */
export function hasCost(product: Pick<ProductListRow, 'defaultCost'>): boolean {
  return product.defaultCost !== undefined;
}

export function variantHasCost(variant: Pick<Variant, 'cost'>): boolean {
  return variant.cost !== undefined;
}

/**
 * A variant's human label: its attribute values in the order the server
 * returned them, falling back to the SKU for a product with no attributes
 * (the single auto-generated variant of a simple product).
 *
 * Generic on purpose. It prints "Large / Red" for a garment and
 * "12kg / 220V" for a washing machine because both are just Attribute
 * names a tenant defined; nothing here knows what a size is.
 */
export function variantLabel(variant: Variant): string {
  return variantAttributes(variant) ?? variant.sku;
}

/**
 * Just the attribute values, or null when the variant has none.
 *
 * Separate from `variantLabel` because the two callers want opposite
 * things from an attribute-less variant: a bundle row needs SOMETHING to
 * name the component (so it falls back to the SKU), whereas the variant
 * table already has a SKU column beside it and would otherwise print the
 * same string twice.
 */
export function variantAttributes(variant: Variant): string | null {
  const parts = variant.attributeValues.map((av) => av.attributeValue.value).filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : null;
}

/** The primary barcode a scanner would read, when one is marked. */
export function primaryBarcode(variant: Variant): string | null {
  return variant.barcodes.find((b) => b.isPrimary)?.code ?? variant.barcodes[0]?.code ?? null;
}

/**
 * Whether a bundle's composition may be edited at all.
 *
 * `PUT /catalog/products/:id/bundle-items` refuses a non-BUNDLE product
 * with a 422, so offering the control on a SIMPLE product would hand a
 * user an action that must fail.
 */
export function canEditBundle(product: Pick<ProductDetail, 'type'>): boolean {
  return product.type === 'BUNDLE';
}

/**
 * A bundle's components, flattened for display.
 *
 * WHAT THIS DOES NOT DO: work out what selling one bundle consumes from
 * stock. That is `InventoryEngineService`, it is server-side, and it is
 * explicitly untouched by this milestone.
 */
export function bundleComponents(items: BundleItem[]): { variantId: string; sku: string; name: string; quantity: string }[] {
  return items.map((i) => ({
    variantId: i.componentVariantId,
    sku: i.componentVariant.sku,
    name: i.componentVariant.product.name,
    quantity: i.quantity,
  }));
}

/**
 * The status a deactivation moves a product to.
 *
 * INACTIVE, never DISCONTINUED. Both exist in the contract and mean
 * different things to a merchant — withdrawn for now versus never coming
 * back — so the UI offers the reversible one by default and lets the
 * status field carry the other explicitly. Guessing between them would be
 * inventing policy.
 */
export const DEACTIVATED_STATUS: ProductStatus = 'INACTIVE';

/** Page numbers worth rendering, given the server's own pagination block. */
export function pageWindow(page: number, totalPages: number, span = 2): number[] {
  const first = Math.max(1, Math.min(page - span, totalPages - span * 2));
  const last = Math.min(totalPages, Math.max(page + span, span * 2 + 1));
  const out: number[] = [];
  for (let p = first; p <= last; p++) out.push(p);
  return out;
}
