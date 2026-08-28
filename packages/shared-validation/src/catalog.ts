import { z } from 'zod';
import { nameSchema } from './primitives';

/** NUMERIC(18,4)-range money/quantity value. Never NaN/Infinity, never negative. */
export const moneySchema = z.number().finite().nonnegative().max(999_999_999_999);
export const positiveQuantitySchema = z.number().finite().positive().max(999_999_999_999);

export const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'SKU may contain only letters, numbers, dot, underscore, hyphen');

export const barcodeCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+$/, 'Barcode may contain only letters and numbers');

const imageSchema = z.object({
  url: z.string().trim().url().max(2000),
  altText: z.string().trim().max(200).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const createCategorySchema = z.object({
  name: nameSchema,
  parentId: z.string().uuid().optional(),
  description: z.string().trim().max(1000).optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: nameSchema.optional(),
  parentId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export const createBrandSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(1000).optional(),
});
export type CreateBrandInput = z.infer<typeof createBrandSchema>;

export const updateBrandSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;

// ---------------------------------------------------------------------------
// Units of Measure
// ---------------------------------------------------------------------------

export const createUomSchema = z.object({
  name: nameSchema,
  code: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]+$/, 'Code may contain only letters and numbers')),
  precision: z.number().int().min(0).max(6).default(0),
});
export type CreateUomInput = z.infer<typeof createUomSchema>;

export const updateUomSchema = z.object({
  name: nameSchema.optional(),
  precision: z.number().int().min(0).max(6).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateUomInput = z.infer<typeof updateUomSchema>;

// ---------------------------------------------------------------------------
// Attributes & values
// ---------------------------------------------------------------------------

export const createAttributeSchema = z.object({
  name: nameSchema,
});
export type CreateAttributeInput = z.infer<typeof createAttributeSchema>;

export const updateAttributeSchema = z.object({
  name: nameSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateAttributeInput = z.infer<typeof updateAttributeSchema>;

export const createAttributeValueSchema = z.object({
  value: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).optional().default(0),
});
export type CreateAttributeValueInput = z.infer<typeof createAttributeValueSchema>;

export const updateAttributeValueSchema = z.object({
  value: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.number().int().min(0).optional(),
});
export type UpdateAttributeValueInput = z.infer<typeof updateAttributeValueSchema>;

// ---------------------------------------------------------------------------
// Products & Variants
//
// Design decision (documented in docs/state/PROJECT_STATE.md): a Product's
// defaultCost/defaultSellingPrice are creation-time defaults used to seed
// auto-generated variants and are NOT independently editable afterward -
// the operationally meaningful price/cost always lives on the
// ProductVariant, changed through the dedicated change-cost/change-price
// endpoints below (each requiring its own permission and writing a
// ProductPriceHistory row). This avoids two competing "sources of truth"
// for a simple product's price.
// ---------------------------------------------------------------------------

const productVariantInputSchema = z.object({
  sku: skuSchema,
  cost: moneySchema.optional(),
  sellingPrice: moneySchema.optional(),
  weight: moneySchema.optional(),
  attributeValueIds: z.array(z.string().uuid()).optional().default([]),
  barcodes: z.array(barcodeCodeSchema).optional().default([]),
});
export type ProductVariantInput = z.infer<typeof productVariantInputSchema>;

export const createProductSchema = z
  .object({
    sku: skuSchema,
    name: nameSchema,
    alternativeName: nameSchema.optional(),
    categoryId: z.string().uuid().optional(),
    brandId: z.string().uuid().optional(),
    description: z.string().trim().max(2000).optional(),
    type: z.enum(['SIMPLE', 'BUNDLE']).default('SIMPLE'),
    defaultCost: moneySchema.default(0),
    defaultSellingPrice: moneySchema.default(0),
    minimumStock: moneySchema.optional(),
    maximumStock: moneySchema.optional(),
    baseUomId: z.string().uuid(),
    images: z.array(imageSchema).max(20).optional(),
    /// Phase 3 (Inventory Engine): whether receipts/consumptions for this
    /// product's variants require lot/expiry or serial-number data.
    tracksLots: z.boolean().optional().default(false),
    tracksSerialNumbers: z.boolean().optional().default(false),
    variants: z.array(productVariantInputSchema).max(200).optional(),
    bundleItems: z
      .array(z.object({ variantId: z.string().uuid(), quantity: positiveQuantitySchema }))
      .max(100)
      .optional(),
  })
  .refine((d) => d.minimumStock === undefined || d.maximumStock === undefined || d.maximumStock >= d.minimumStock, {
    message: 'maximumStock must be greater than or equal to minimumStock',
    path: ['maximumStock'],
  })
  .refine((d) => d.type === 'BUNDLE' || !d.bundleItems || d.bundleItems.length === 0, {
    message: 'bundleItems is only allowed when type is BUNDLE',
    path: ['bundleItems'],
  })
  .refine((d) => d.type !== 'BUNDLE' || (d.bundleItems && d.bundleItems.length > 0), {
    message: 'A BUNDLE product requires at least one bundle item',
    path: ['bundleItems'],
  });
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    name: nameSchema.optional(),
    alternativeName: nameSchema.nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    brandId: z.string().uuid().nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'DISCONTINUED']).optional(),
    minimumStock: moneySchema.nullable().optional(),
    maximumStock: moneySchema.nullable().optional(),
    images: z.array(imageSchema).max(20).optional(),
    tracksLots: z.boolean().optional(),
    tracksSerialNumbers: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.minimumStock == null ||
      d.maximumStock == null ||
      d.maximumStock >= d.minimumStock,
    { message: 'maximumStock must be greater than or equal to minimumStock', path: ['maximumStock'] },
  );
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const addVariantSchema = productVariantInputSchema;
export type AddVariantInput = z.infer<typeof addVariantSchema>;

export const updateVariantSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  weight: moneySchema.nullable().optional(),
  dimensions: z
    .object({
      length: moneySchema,
      width: moneySchema,
      height: moneySchema,
      unit: z.string().trim().max(10),
    })
    .nullable()
    .optional(),
  images: z.array(imageSchema).max(20).optional(),
});
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;

export const changeVariantCostSchema = z.object({ cost: moneySchema });
export type ChangeVariantCostInput = z.infer<typeof changeVariantCostSchema>;

export const changeVariantPriceSchema = z.object({ sellingPrice: moneySchema });
export type ChangeVariantPriceInput = z.infer<typeof changeVariantPriceSchema>;

export const productListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'DISCONTINUED']).optional(),
  type: z.enum(['SIMPLE', 'BUNDLE']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

export const variantLookupQuerySchema = z
  .object({
    barcode: z.string().trim().min(1).max(64).optional(),
    sku: z.string().trim().min(1).max(64).optional(),
  })
  .refine((d) => Boolean(d.barcode || d.sku), { message: 'barcode or sku query parameter is required' });
export type VariantLookupQuery = z.infer<typeof variantLookupQuerySchema>;

export const catalogSyncQuerySchema = z.object({
  updatedSince: z.string().datetime().optional(),
  includeInactive: z.coerce.boolean().optional().default(false),
});
export type CatalogSyncQuery = z.infer<typeof catalogSyncQuerySchema>;

// ---------------------------------------------------------------------------
// Product UOMs & Barcodes
// ---------------------------------------------------------------------------

export const addProductUomSchema = z.object({
  uomId: z.string().uuid(),
  conversionFactor: positiveQuantitySchema,
  isPurchaseUom: z.boolean().optional().default(false),
  isSalesUom: z.boolean().optional().default(false),
});
export type AddProductUomInput = z.infer<typeof addProductUomSchema>;

export const addBarcodeSchema = z.object({
  code: barcodeCodeSchema,
  productUomId: z.string().uuid().optional(),
  isPrimary: z.boolean().optional().default(false),
});
export type AddBarcodeInput = z.infer<typeof addBarcodeSchema>;

// ---------------------------------------------------------------------------
// Price Lists
// ---------------------------------------------------------------------------

export const createPriceListSchema = z.object({
  name: nameSchema,
  isDefault: z.boolean().optional().default(false),
});
export type CreatePriceListInput = z.infer<typeof createPriceListSchema>;

export const updatePriceListSchema = z.object({
  name: nameSchema.optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;

export const upsertPriceListEntrySchema = z.object({
  variantId: z.string().uuid(),
  price: moneySchema,
});
export type UpsertPriceListEntryInput = z.infer<typeof upsertPriceListEntrySchema>;

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

export const replaceBundleItemsSchema = z.object({
  items: z
    .array(z.object({ variantId: z.string().uuid(), quantity: positiveQuantitySchema }))
    .min(1, 'A bundle requires at least one item')
    .max(100),
});
export type ReplaceBundleItemsInput = z.infer<typeof replaceBundleItemsSchema>;
