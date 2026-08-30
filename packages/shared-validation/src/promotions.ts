import { z } from 'zod';

/**
 * Calendar-date input. The instant it resolves to depends on the
 * BUSINESS timezone, which only the server knows, so the wire format is
 * deliberately a plain `YYYY-MM-DD` rather than an ISO instant: accepting
 * an instant would let a caller in another timezone shift a promotion's
 * effective window. `validTo` is resolved to the EXCLUSIVE instant at the
 * start of the following day, giving the half-open `[validFrom, validTo)`
 * interval the rest of the system uses.
 */
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date in YYYY-MM-DD form');

const promotionNameSchema = z.string().trim().min(1).max(200);

/** 0 < value <= 100 - above 100 would drive a line negative, at or below
 * zero it is not a discount. Mirrored by the
 * `promotions_percentage_range` CHECK. */
const percentageValueSchema = z.number().finite().gt(0).max(100);
const fixedAmountSchema = z.number().finite().gt(0).max(999_999_999_999);
/** X and Y are whole units of stock, so integers only. */
const setQuantitySchema = z.number().int().gt(0).max(1_000_000);

const promotionTargetSchema = z.object({
  targetType: z.enum(['PRODUCT', 'VARIANT', 'CATEGORY']),
  targetId: z.string().uuid(),
});

/**
 * A promotion carries exactly ONE parameter set, matching its type. The
 * discriminated union makes the wrong combination unrepresentable at the
 * boundary, and the `promotions_parameters_match_type` CHECK enforces the
 * same rule independently at the database layer.
 */
export const createPromotionSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('PERCENTAGE'), percentageValue: percentageValueSchema }),
    /// `fixedAmount` is PER UNIT, not per line (approved semantics).
    z.object({ type: z.literal('FIXED_AMOUNT'), fixedAmount: fixedAmountSchema }),
    z.object({
      type: z.literal('BUY_X_GET_Y'),
      /// Units that must be paid for.
      buyQuantity: setQuantitySchema,
      /// Units given free. Y is INSIDE the set: a set is X + Y units, so
      /// "Buy 2 Get 1" needs 3 units on the line.
      getQuantity: setQuantitySchema,
    }),
  ])
  .and(promotionTargetSchema)
  .and(
    z.object({
      name: promotionNameSchema,
      validFrom: calendarDateSchema,
      validTo: calendarDateSchema,
    }),
  );
export type CreatePromotionInput = z.infer<typeof createPromotionSchema>;

/**
 * Only the name, the window and the active flag are editable. Type,
 * target and parameters are NOT: changing what a promotion fundamentally
 * is would silently repurpose the rule that historical
 * `SalePromotionApplication` rows point at, making their `promotionName`
 * and type disagree with the row they reference. A different rule is a
 * different promotion.
 */
export const updatePromotionSchema = z
  .object({
    name: promotionNameSchema.optional(),
    validFrom: calendarDateSchema.optional(),
    validTo: calendarDateSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdatePromotionInput = z.infer<typeof updatePromotionSchema>;

export const promotionListQuerySchema = z.object({
  type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT', 'BUY_X_GET_Y']).optional(),
  targetType: z.enum(['PRODUCT', 'VARIANT', 'CATEGORY']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PromotionListQuery = z.infer<typeof promotionListQuerySchema>;
