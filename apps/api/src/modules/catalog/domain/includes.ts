/** Shared Prisma `include` shapes so Product/Variant responses look
 * identical whether they come from create, get, list-detail, lookup, or
 * sync — one shape, reused, not redefined slightly differently per
 * endpoint. */

export const VARIANT_INCLUDE = {
  product: true,
  attributeValues: { include: { attributeValue: { include: { attribute: true } } } },
  barcodes: true,
} as const;

export const PRODUCT_INCLUDE = {
  category: true,
  brand: true,
  baseUom: true,
  variants: {
    include: {
      attributeValues: { include: { attributeValue: { include: { attribute: true } } } },
      barcodes: true,
    },
  },
  productUoms: { include: { uom: true } },
  bundleItems: { include: { componentVariant: { include: { product: true } } } },
} as const;
