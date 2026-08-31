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
