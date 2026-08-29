import { z } from 'zod';

/**
 * Upper bound is TECHNICAL, not a business maximum: Phase 0 defines no
 * maximum warranty length and inventing one was explicitly forbidden.
 * 36500 days (100 years) simply keeps `startDate + durationDays` inside a
 * valid timestamp range, and is mirrored by the
 * `warranties_duration_days_technical_bound` CHECK constraint so the
 * database enforces the same limit independently of this schema.
 */
export const warrantyDurationDaysSchema = z.coerce.number().int().positive().max(36500);

export const registerWarrantySchema = z.object({
  saleItemId: z.string().uuid(),
  serialNumberId: z.string().uuid(),
  /// Optional per-registration override. When omitted, the business
  /// default from Setting['warranty.default_duration_days'] is used.
  durationDays: warrantyDurationDaysSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type RegisterWarrantyInput = z.infer<typeof registerWarrantySchema>;

export const warrantyListQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'EXPIRED', 'CLAIMED', 'VOID']).optional(),
  customerId: z.string().uuid().optional(),
  serialNumberId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type WarrantyListQuery = z.infer<typeof warrantyListQuerySchema>;

export const registerWarrantyClaimSchema = z.object({
  description: z.string().trim().min(1).max(2000),
});
export type RegisterWarrantyClaimInput = z.infer<typeof registerWarrantyClaimSchema>;

/**
 * A claim transitions OPEN -> RESOLVED | REJECTED only. There is
 * deliberately no path back to OPEN and no other status: approved
 * Phase 8A decision 15 fixes the workflow at exactly three states, and
 * anything richer would be inventing a workflow.
 */
export const resolveWarrantyClaimSchema = z.object({
  status: z.enum(['RESOLVED', 'REJECTED']),
  resolution: z.string().trim().max(2000).optional(),
});
export type ResolveWarrantyClaimInput = z.infer<typeof resolveWarrantyClaimSchema>;

/**
 * Voiding is a status change only - it never edits the snapshotted
 * coverage dates, never touches inventory, and never posts to the ledger.
 * The reason is optional free text recorded in the audit trail.
 */
export const voidWarrantySchema = z.object({
  reason: z.string().trim().min(1).max(1000).optional(),
});
export type VoidWarrantyInput = z.infer<typeof voidWarrantySchema>;
