import { z } from 'zod';

/**
 * Points use the same Decimal(18,4) representation as every other
 * quantity in the system. An adjustment may be signed either way (a
 * correction can legitimately add or remove points) but never zero - a
 * zero-point event carries no information, and the
 * `customer_points_nonzero` CHECK enforces the same rule at the database
 * layer.
 */
export const loyaltyAdjustmentPointsSchema = z
  .union([z.number(), z.string()])
  .refine((v) => Number.isFinite(Number(v)) && Number(v) !== 0, {
    message: 'points must be a non-zero number',
  })
  .refine((v) => Math.abs(Number(v)) <= 1_000_000_000, {
    message: 'points is out of the supported range',
  });

/**
 * A manual adjustment carries its own idempotencyKey (REQUIRED, unlike
 * the optional keys on Sales' endpoints): machine-generated EARN/REDEEM/
 * RETURN_CLAWBACK rows inherit the idempotency of the Sale or SaleReturn
 * that produced them, so this human-entered endpoint is the only write to
 * the ledger with no source document behind it and therefore the only one
 * that could be double-submitted with nothing to detect it.
 *
 * A reason is likewise required, not optional: a point grant with no
 * stated cause is exactly the kind of ledger entry an audit cannot
 * explain later.
 */
export const adjustCustomerPointsSchema = z.object({
  points: loyaltyAdjustmentPointsSchema,
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(120),
});
export type AdjustCustomerPointsInput = z.infer<typeof adjustCustomerPointsSchema>;

export const customerPointsListQuerySchema = z.object({
  type: z.enum(['EARN', 'REDEEM', 'RETURN_CLAWBACK', 'ADJUSTMENT']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CustomerPointsListQuery = z.infer<typeof customerPointsListQuerySchema>;
