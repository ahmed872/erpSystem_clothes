import { z } from 'zod';

/**
 * Phase 10 (BD-17) — cash registers and till reconciliation.
 *
 * Shared between the API and any client, so a POS built against this
 * contract validates the same shapes the server enforces. Server-side
 * validation always remains authoritative.
 */

/// Local copies, matching the convention every other module in this
/// package follows (sales.ts and purchasing.ts each define their own).
const nonNegativeMoneySchema = z.number().finite().nonnegative().max(999_999_999_999);
const positiveMoneySchema = z.number().finite().positive().max(999_999_999_999);

const codeSchema = z.string().trim().min(1).max(40);
const nameSchema = z.string().trim().min(1).max(120);
const reasonSchema = z.string().trim().min(1).max(500);

export const createCashRegisterSchema = z.object({
  branchId: z.string().uuid(),
  name: nameSchema,
  /// Unique per business - the human-facing till identifier ("TILL-01").
  code: codeSchema,
});
export type CreateCashRegisterInput = z.infer<typeof createCashRegisterSchema>;

export const updateCashRegisterSchema = z.object({
  name: nameSchema.optional(),
  code: codeSchema.optional(),
  /// Retirement is a deactivation, never a delete: a register that once
  /// hosted a shift must stay resolvable forever.
  isActive: z.boolean().optional(),
});
export type UpdateCashRegisterInput = z.infer<typeof updateCashRegisterSchema>;

export const listCashRegistersQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  includeInactive: z.coerce.boolean().default(false),
});
export type ListCashRegistersQuery = z.infer<typeof listCashRegistersQuerySchema>;

/**
 * BD-17 rule 2: opening a shift requires BOTH the register and the
 * opening cash amount. Neither is optional, and `openingFloat` may be
 * zero (a till that starts empty is a real and common case) but never
 * negative.
 */
export const openShiftSchema = z.object({
  warehouseId: z.string().uuid(),
  cashRegisterId: z.string().uuid(),
  openingFloat: nonNegativeMoneySchema.default(0),
});
export type OpenShiftInput = z.infer<typeof openShiftSchema>;

/**
 * BD-17 rule 4 — BLIND CLOSE. The cashier submits what they physically
 * counted; the request carries no expected figure and the response to a
 * user without `shifts.view_expected` carries none either. The server
 * never alters this number (rule 6).
 */
export const closeShiftSchema = z.object({
  countedCash: nonNegativeMoneySchema,
  notes: z.string().trim().max(500).optional(),
});
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;

/**
 * BD-17 rule 5 — the manager's review. This is an ACKNOWLEDGEMENT, not a
 * correction: there is deliberately no field here that could overwrite
 * the cashier's counted amount or the posted variance.
 */
export const reconcileShiftSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});
export type ReconcileShiftInput = z.infer<typeof reconcileShiftSchema>;

/**
 * A manual movement of cash in or out of an open drawer. Sale tenders and
 * refunds are NOT created through this endpoint - they are written by the
 * sale and return use-cases themselves, so the drawer can never disagree
 * with the documents that moved it.
 */
export const createCashMovementSchema = z.object({
  type: z.enum(['PAY_IN', 'PAY_OUT']),
  /// Always the positive magnitude; the server applies the sign that
  /// matches the type, and a CHECK constraint enforces the agreement.
  amount: positiveMoneySchema,
  reason: reasonSchema,
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
});
export type CreateCashMovementInput = z.infer<typeof createCashMovementSchema>;

/**
 * Phase 10 (BD-18) — tax configuration.
 *
 * Rates are CONFIGURATION. No jurisdiction, rate or regime is assumed
 * anywhere in the product: a business defines whatever taxes it is subject
 * to, names them itself, and switches them on or off.
 */
export const createTaxSchema = z.object({
  name: nameSchema,
  /// A PERCENTAGE: 14 means 14%. Zero is valid (an explicitly zero-rated
  /// tax is a real thing and is not the same as no tax at all).
  ratePercent: z.number().finite().min(0).max(1000),
});
export type CreateTaxInput = z.infer<typeof createTaxSchema>;

export const updateTaxSchema = z.object({
  name: nameSchema.optional(),
  /// Editing a rate changes what FUTURE sales are charged. It can never
  /// reach a historical sale, because each line snapshots the rate that
  /// produced its tax (BD-18 rule 4).
  ratePercent: z.number().finite().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateTaxInput = z.infer<typeof updateTaxSchema>;

export const updateTaxSettingsSchema = z.object({
  taxPricingMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']).optional(),
  /// Applied to any product that names no tax of its own. Explicitly
  /// nullable, so a business can remove the default entirely.
  defaultTaxId: z.string().uuid().nullable().optional(),
});
export type UpdateTaxSettingsInput = z.infer<typeof updateTaxSettingsSchema>;

// ======================================================================
// Phase 10 (10H) — EXPENSES
// ======================================================================

/**
 * A category is the bridge between an everyday word ("rent", "delivery van
 * fuel") and the GL account it lands in. The account is chosen by the
 * business rather than derived from a fixed list, because no product can
 * know what a given shop counts as an expense line - the same posture
 * `AccountingMappingRule` already takes for everything else.
 */
export const createExpenseCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  /// Must be an EXPENSE-type account. Checked server-side, where the
  /// account's type is actually known.
  accountId: z.string().uuid(),
});
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const updateExpenseCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    accountId: z.string().uuid().optional(),
    /// Categories are never deleted - an expense already posted against
    /// one must stay explicable forever.
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

/**
 * Money leaving the business for something other than stock.
 *
 * There is no `branchId`: it comes from the acting user's open shift for a
 * cash expense, and from the business's own default otherwise. Letting a
 * client name a branch would let an expense be charged to one it never
 * touched.
 */
export const createExpenseSchema = z.object({
  expenseCategoryId: z.string().uuid(),
  amount: z.number().finite().positive().max(999_999_999_999),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER']).default('CASH'),
  reference: z.string().trim().max(200).optional(),
  description: z.string().trim().max(500).optional(),
  /// The date the business considers the expense to have occurred, which
  /// is not always the date it was typed in. Defaults to today.
  expenseDate: z.string().trim().max(40).optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const expenseListQuerySchema = z.object({
  expenseCategoryId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ExpenseListQuery = z.infer<typeof expenseListQuerySchema>;
