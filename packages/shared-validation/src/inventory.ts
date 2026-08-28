import { z } from 'zod';
import { moneySchema, positiveQuantitySchema } from './catalog';

const isoDate = z.string().datetime();
const serialCode = z.string().trim().min(1).max(120);
const lotNumberSchema = z.string().trim().min(1).max(80);
const referenceTypeSchema = z.string().trim().max(60);
const referenceIdSchema = z.string().trim().max(120);
const reasonSchema = z.string().trim().max(500);

const lotAndSerialFields = {
  lotNumber: lotNumberSchema.optional(),
  expiryDate: isoDate.optional(),
  manufacturingDate: isoDate.optional(),
  serials: z.array(serialCode).max(10_000).optional(),
};

export const recordOpeningStockSchema = z.object({
  warehouseId: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: positiveQuantitySchema,
  unitCost: moneySchema,
  uomId: z.string().uuid().optional(),
  reason: reasonSchema.optional(),
  ...lotAndSerialFields,
});
export type RecordOpeningStockInput = z.infer<typeof recordOpeningStockSchema>;

export const receiveStockSchema = z.object({
  warehouseId: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: positiveQuantitySchema,
  unitCost: moneySchema,
  uomId: z.string().uuid().optional(),
  movementType: z.enum(['PURCHASE', 'SALES_RETURN']).default('PURCHASE'),
  referenceType: referenceTypeSchema.optional(),
  referenceId: referenceIdSchema.optional(),
  reason: reasonSchema.optional(),
  ...lotAndSerialFields,
});
export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;

export const consumeStockSchema = z.object({
  warehouseId: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: positiveQuantitySchema,
  uomId: z.string().uuid().optional(),
  movementType: z.enum(['SALE', 'PURCHASE_RETURN']).default('SALE'),
  referenceType: referenceTypeSchema.optional(),
  referenceId: referenceIdSchema.optional(),
  reason: reasonSchema.optional(),
  lotId: z.string().uuid().optional(),
  serials: z.array(serialCode).max(10_000).optional(),
});
export type ConsumeStockInput = z.infer<typeof consumeStockSchema>;

export const adjustStockSchema = z.object({
  warehouseId: z.string().uuid(),
  variantId: z.string().uuid(),
  /// Signed: positive = found extra stock, negative = shrinkage/damage/loss.
  quantity: z
    .number()
    .finite()
    .refine((v) => v !== 0, 'quantity cannot be zero')
    .refine((v) => Math.abs(v) <= 999_999_999_999, 'quantity out of range'),
  movementType: z.enum(['ADJUSTMENT', 'DAMAGE', 'LOSS', 'INTERNAL_CONSUMPTION', 'EXPIRY']),
  reason: reasonSchema.min(1, 'A reason is required for stock adjustments'),
  uomId: z.string().uuid().optional(),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

export const createStockTransferSchema = z
  .object({
    sourceWarehouseId: z.string().uuid(),
    destinationWarehouseId: z.string().uuid(),
    items: z.array(z.object({ variantId: z.string().uuid(), quantity: positiveQuantitySchema })).min(1).max(500),
  })
  .refine((d) => d.sourceWarehouseId !== d.destinationWarehouseId, {
    message: 'Source and destination warehouse must be different',
    path: ['destinationWarehouseId'],
  });
export type CreateStockTransferInput = z.infer<typeof createStockTransferSchema>;

export const receiveStockTransferSchema = z.object({
  items: z
    .array(z.object({ variantId: z.string().uuid(), quantityReceived: z.number().finite().min(0) }))
    .min(1)
    .max(500),
});
export type ReceiveStockTransferInput = z.infer<typeof receiveStockTransferSchema>;

export const createStockCountSchema = z.object({
  warehouseId: z.string().uuid(),
  /// Omit to snapshot every variant that currently has a StockBalance row
  /// in this warehouse.
  variantIds: z.array(z.string().uuid()).max(5000).optional(),
});
export type CreateStockCountInput = z.infer<typeof createStockCountSchema>;

export const submitStockCountItemsSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        actualQuantity: z.number().finite().min(0),
        reason: reasonSchema.optional(),
      }),
    )
    .min(1)
    .max(5000),
});
export type SubmitStockCountItemsInput = z.infer<typeof submitStockCountItemsSchema>;

export const inventoryListQuerySchema = z.object({
  warehouseId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  movementType: z
    .enum([
      'OPENING_BALANCE',
      'PURCHASE',
      'SALE',
      'SALES_RETURN',
      'PURCHASE_RETURN',
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'STOCK_COUNT',
      'ADJUSTMENT',
      'DAMAGE',
      'LOSS',
      'INTERNAL_CONSUMPTION',
      'EXPIRY',
      'BUNDLE_CONSUMPTION',
      'AUTHORIZED_CORRECTION',
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type InventoryListQuery = z.infer<typeof inventoryListQuerySchema>;

export const balanceQuerySchema = z.object({
  warehouseId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
});
export type BalanceQuery = z.infer<typeof balanceQuerySchema>;
