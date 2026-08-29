import { z } from 'zod';

/**
 * Shared query shape for every report. Date bounds are OPTIONAL at the
 * schema level (the server defaults them to the current month in the
 * business's own timezone - see resolveDateRange) but are always
 * RESOLVED and bounded server-side: no report ever runs an unbounded
 * scan, which is the main performance guardrail for large Sales/
 * StockMovement/JournalEntry datasets.
 *
 * `to` is an INCLUSIVE calendar date from the caller's perspective; the
 * server converts it to an exclusive upper bound internally.
 */
export const reportRangeQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  branchId: z.string().uuid().optional(),
});
export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;

/** Range + pagination, for the reports that return row lists. */
export const reportListQuerySchema = reportRangeQuerySchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  // Max 200 matches the limit every other list endpoint in this codebase
  // already enforces - reports are not exempt from that ceiling.
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReportListQuery = z.infer<typeof reportListQuerySchema>;

export const salesByDimensionQuerySchema = reportListQuerySchema.extend({
  warehouseId: z.string().uuid().optional(),
});
export type SalesByDimensionQuery = z.infer<typeof salesByDimensionQuerySchema>;

export const inventoryMovementsQuerySchema = reportListQuerySchema.extend({
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
});
export type InventoryMovementsQuery = z.infer<typeof inventoryMovementsQuerySchema>;

export const inventoryValuationQuerySchema = z.object({
  warehouseId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type InventoryValuationQuery = z.infer<typeof inventoryValuationQuerySchema>;

export const slowMovingQuerySchema = z.object({
  warehouseId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  /** Days without a SALE movement before a variant counts as slow-moving. */
  days: z.coerce.number().int().min(1).max(3650).default(90),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SlowMovingQuery = z.infer<typeof slowMovingQuerySchema>;

export const generalLedgerQuerySchema = reportListQuerySchema.extend({
  accountId: z.string().uuid().optional(),
});
export type GeneralLedgerQuery = z.infer<typeof generalLedgerQuerySchema>;

/** Balance Sheet is an "as at" report - a single instant, not a range. */
export const balanceSheetQuerySchema = z.object({
  asAt: z.coerce.date().optional(),
});
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;

export const receivablesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReceivablesQuery = z.infer<typeof receivablesQuerySchema>;

export const reconciliationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;
