/** Shallow-clones `obj` with `keys` removed. Used to strip cost fields from
 * catalog responses for callers without products.view_cost. */
export function omitFields<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const clone = { ...obj } as T;
  for (const key of keys) {
    delete clone[key];
  }
  return clone;
}

/**
 * Phase 14 — THE ONE PLACE THAT DECIDES WHETHER COST LEAVES THE SERVER.
 *
 * The catalogue's READ paths (`listProducts`, `getProduct`, `getVariant`,
 * the sync feed) have always stripped cost for a caller without
 * `products.view_cost`. Its WRITE paths did not: `PATCH /catalog/products/:id`,
 * `PATCH /catalog/variants/:id`, `PATCH /catalog/variants/:id/price` and
 * `POST /catalog/products/:id/variants` each returned the freshly-written
 * row verbatim, cost included.
 *
 * That is reachable, not theoretical. `products.edit` and
 * `products.change_price` are separate grants from `products.view_cost`,
 * and a tenant may define a role holding one without the other — a
 * merchandiser who sets shelf prices but is not shown the shop's margin is
 * an ordinary arrangement. Renaming such a product returned its cost.
 *
 * So the rule is expressed ONCE here and applied on the way out of every
 * path, read and write alike. A response shape must not depend on which
 * verb produced it.
 */
export const PRODUCT_COST_FIELDS = ['defaultCost'] as const;
export const VARIANT_COST_FIELDS = ['cost'] as const;

/** Strips a Product's cost, and its variants' costs when they are loaded. */
export function stripProductCost<T extends { defaultCost?: unknown; variants?: unknown[] }>(product: T, canViewCost: boolean) {
  if (canViewCost) return product;
  const bare = omitFields(product, PRODUCT_COST_FIELDS as unknown as readonly (keyof T)[]);
  if (!Array.isArray(product.variants)) return bare;
  return {
    ...bare,
    variants: product.variants.map((v) => omitFields(v as object, VARIANT_COST_FIELDS as never)),
  };
}

/** Strips a ProductVariant's cost. */
export function stripVariantCost<T extends { cost?: unknown }>(variant: T, canViewCost: boolean) {
  return canViewCost ? variant : omitFields(variant, VARIANT_COST_FIELDS as unknown as readonly (keyof T)[]);
}
