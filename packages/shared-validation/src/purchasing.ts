import { z } from 'zod';
import { positiveQuantitySchema } from './catalog';
import { nameSchema } from './primitives';

const isoDate = z.string().datetime();
const notesSchema = z.string().trim().max(1000);
const nonNegativeMoneySchema = z.number().finite().nonnegative().max(999_999_999_999);

export const createSupplierSchema = z.object({
  name: nameSchema,
  contactPerson: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  taxNumber: z.string().trim().max(100).optional(),
  paymentTermsDays: z.number().int().min(0).max(3650).optional(),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = createSupplierSchema.partial();
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export const supplierListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;

const purchaseItemInputSchema = z.object({
  variantId: z.string().uuid(),
  quantityOrdered: positiveQuantitySchema,
  unitCost: nonNegativeMoneySchema,
  taxAmount: nonNegativeMoneySchema.default(0),
  discountAmount: nonNegativeMoneySchema.default(0),
});

export const createPurchaseSchema = z.object({
  /// branchId is deliberately NOT accepted here - it's always derived
  /// server-side from warehouse.branchId (same convention as every
  /// Phase 3 stock-affecting use-case), so a caller can never supply a
  /// branchId/warehouseId pair that don't actually match each other.
  warehouseId: z.string().uuid(),
  supplierId: z.string().uuid(),
  expectedDate: isoDate.optional(),
  notes: notesSchema.optional(),
  items: z.array(purchaseItemInputSchema).min(1).max(500),
});
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;

export const updatePurchaseSchema = z.object({
  supplierId: z.string().uuid().optional(),
  expectedDate: isoDate.optional(),
  notes: notesSchema.optional(),
  items: z.array(purchaseItemInputSchema).min(1).max(500).optional(),
});
export type UpdatePurchaseInput = z.infer<typeof updatePurchaseSchema>;

export const cancelPurchaseSchema = z.object({
  reason: notesSchema.optional(),
});
export type CancelPurchaseInput = z.infer<typeof cancelPurchaseSchema>;

export const receivePurchaseSchema = z.object({
  /// Always received into the Purchase's own warehouseId - not
  /// independently selectable per receipt (a PO targets one warehouse).
  notes: notesSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
  items: z
    .array(
      z.object({
        purchaseItemId: z.string().uuid(),
        quantityReceived: positiveQuantitySchema,
        /// Phase 10 (10D): the exact physical units arriving. REQUIRED for a
        /// serial-tracked variant and rejected for one that is not - the
        /// server decides which, because only it knows the product's
        /// tracking flag. Same posture, and the same rule, as BD-13 on the
        /// sale side. The count must equal the quantity.
        serials: z.array(z.string().trim().min(1).max(120)).max(10_000).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type ReceivePurchaseInput = z.infer<typeof receivePurchaseSchema>;

export const createPurchaseReturnSchema = z.object({
  /// Always returned from the Purchase's own warehouseId - see
  /// receivePurchaseSchema.
  reason: notesSchema.optional(),
  items: z
    .array(
      z.object({
        purchaseItemId: z.string().uuid(),
        quantity: positiveQuantitySchema,
        /// Phase 10 (10D): the exact physical units going back to the
        /// supplier. REQUIRED for a serial-tracked variant, rejected for
        /// one that is not, and the count must equal the quantity. The
        /// units must be IN_STOCK at the purchase's warehouse: you cannot
        /// send back something already sold or already returned.
        serials: z.array(z.string().trim().min(1).max(120)).max(10_000).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type CreatePurchaseReturnInput = z.infer<typeof createPurchaseReturnSchema>;

export const createPurchasePaymentSchema = z.object({
  amount: z.number().finite().positive().max(999_999_999_999),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER']).default('CASH'),
  reference: z.string().trim().max(200).optional(),
  notes: notesSchema.optional(),
});
export type CreatePurchasePaymentInput = z.infer<typeof createPurchasePaymentSchema>;

export const purchaseListQuerySchema = z.object({
  supplierId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PurchaseListQuery = z.infer<typeof purchaseListQuerySchema>;
