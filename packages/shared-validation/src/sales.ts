import { z } from 'zod';
import { positiveQuantitySchema } from './catalog';
import { nameSchema } from './primitives';

const notesSchema = z.string().trim().max(1000);
const nonNegativeMoneySchema = z.number().finite().nonnegative().max(999_999_999_999);
const positiveMoneySchema = z.number().finite().positive().max(999_999_999_999);

export const createCustomerSchema = z.object({
  name: nameSchema,
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  taxNumber: z.string().trim().max(100).optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = createCustomerSchema.partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const customerListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export const openShiftSchema = z.object({
  warehouseId: z.string().uuid(),
});
export type OpenShiftInput = z.infer<typeof openShiftSchema>;

const saleItemInputSchema = z.object({
  variantId: z.string().uuid(),
  quantity: positiveQuantitySchema,
  unitPrice: nonNegativeMoneySchema,
  discountAmount: nonNegativeMoneySchema.default(0),
  taxAmount: nonNegativeMoneySchema.default(0),
});

const salePaymentInputSchema = z.object({
  amount: positiveMoneySchema,
  method: z.enum(['CASH', 'CARD', 'WALLET', 'OTHER']).default('CASH'),
  reference: z.string().trim().max(200).optional(),
});

export const createSaleSchema = z.object({
  /// warehouseId only - branchId is always derived server-side from
  /// warehouse.branchId (Phase 3/4 convention).
  warehouseId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  notes: notesSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
  items: z.array(saleItemInputSchema).min(1).max(500),
  /// Payment(s) tendered at the moment of sale. May be empty ONLY for a
  /// credit sale against an identified customer (see the invariant on
  /// the Sale model) - a walk-in sale (no customerId) must be paid in
  /// full here.
  payments: z.array(salePaymentInputSchema).max(20).default([]),
});
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

export const createSalePaymentSchema = z.object({
  amount: positiveMoneySchema,
  method: z.enum(['CASH', 'CARD', 'WALLET', 'OTHER']).default('CASH'),
  reference: z.string().trim().max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
});
export type CreateSalePaymentInput = z.infer<typeof createSalePaymentSchema>;

export const createSaleReturnSchema = z.object({
  reason: notesSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
  items: z
    .array(
      z.object({
        saleItemId: z.string().uuid(),
        quantity: positiveQuantitySchema,
        condition: z.enum(['SELLABLE', 'DAMAGED']).default('SELLABLE'),
      }),
    )
    .min(1)
    .max(500),
});
export type CreateSaleReturnInput = z.infer<typeof createSaleReturnSchema>;

export const saleListQuerySchema = z.object({
  customerId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;
