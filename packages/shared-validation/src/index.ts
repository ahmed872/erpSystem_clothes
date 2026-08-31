import { z } from 'zod';
import { emailSchema, nameSchema, slugSchema, currencyCodeSchema, passwordSchema } from './primitives';

export * from './primitives';
export * from './catalog';
export * from './inventory';
export * from './purchasing';
export * from './sales';
export * from './accounting';
export * from './reporting';
export * from './warranty';
export * from './loyalty';
export * from './promotions';
export * from './finance';

export const registerBusinessSchema = z.object({
  businessName: nameSchema,
  businessSlug: slugSchema,
  currency: currencyCodeSchema.default('EGP'),
  timezone: z.string().trim().min(1).max(64).default('Africa/Cairo'),
  ownerName: nameSchema,
  ownerEmail: emailSchema,
  ownerPassword: passwordSchema,
  defaultBranchName: nameSchema.default('الفرع الرئيسي'),
  defaultWarehouseName: nameSchema.default('المخزن الرئيسي'),
  /// Phase 10: Phase 0 §11 specifies onboarding as
  /// "Business -> default Branch/Warehouse/Register", so a business is
  /// usable from the first request without a separate setup step.
  defaultCashRegisterName: nameSchema.default('الخزينة الرئيسية'),
});
export type RegisterBusinessInput = z.infer<typeof registerBusinessSchema>;

/** Phase 10 (10F): every profile field is free text, nullable, and
 *  trimmed. `null` clears one; omitting it leaves it alone. The product
 *  validates none of them against any national invoicing regime, because
 *  it has not been told which one applies - and inventing a format check
 *  would break the first business whose country works differently. */
const profileText = (max: number) => z.string().trim().max(max).nullable().optional();

export const updateBusinessSchema = z.object({
  name: nameSchema.optional(),
  currency: currencyCodeSchema.optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  legalName: profileText(200),
  taxNumber: profileText(64),
  registrationNumber: profileText(64),
  phone: profileText(40),
  email: profileText(200),
  addressLine: profileText(300),
  city: profileText(120),
  country: profileText(120),
  logoUrl: profileText(500),
  receiptHeader: profileText(500),
  receiptFooter: profileText(500),
});
export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  businessSlug: slugSchema,
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(10),
});
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

export const createUserSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  roleIds: z.array(z.string().uuid()).min(1, 'At least one role is required'),
  branchIds: z.array(z.string().uuid()).optional().default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: nameSchema.optional(),
  roleIds: z.array(z.string().uuid()).min(1).optional(),
  branchIds: z.array(z.string().uuid()).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/**
 * Phase 10 (10G) — a user changes their OWN password.
 *
 * The current password is required, not optional. A logged-in session on
 * an unattended terminal is the ordinary case in a shop, and without this
 * anyone who walked past a signed-in till could lock the real user out of
 * their own account.
 */
export const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export type ChangeOwnPasswordInput = z.infer<typeof changeOwnPasswordSchema>;

/**
 * Phase 10 (10G) — an administrator resets SOMEONE ELSE'S password.
 *
 * The forgotten-password case, which is what actually happens in a shop:
 * the owner sets a new one and tells the person. There is deliberately no
 * self-service email or SMS reset - delivery is out of Phase 10's approved
 * scope, and a reset link nobody can receive is worse than none.
 *
 * No `currentPassword`: the administrator does not know it, which is the
 * whole point. The permission is the check.
 */
export const resetUserPasswordSchema = z.object({
  newPassword: passwordSchema,
});
export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;

export const createRoleSchema = z.object({
  name: nameSchema,
  permissionCodes: z.array(z.string()).min(1, 'At least one permission is required'),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: nameSchema.optional(),
  permissionCodes: z.array(z.string()).min(1).optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const createBranchSchema = z.object({
  name: nameSchema,
  address: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(30).optional(),
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;

export const updateBranchSchema = createBranchSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;

export const createWarehouseSchema = z.object({
  branchId: z.string().uuid(),
  name: nameSchema,
  isDefault: z.boolean().optional().default(false),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = z.object({
  name: nameSchema.optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

export const upsertSettingSchema = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.unknown(),
});
export type UpsertSettingInput = z.infer<typeof upsertSettingSchema>;

/**
 * Phase 11 — reading the audit trail.
 *
 * `audit.view` has existed since Phase 1 and nothing ever served it, so
 * the record every module has been writing since then was unreadable
 * through the API. The filters below are the questions a security review
 * actually asks: what did this person do, what happened to this record,
 * who was denied, and what happened in this window.
 */
export const auditLogListQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  action: z.enum(['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PERMISSION_DENIED']).optional(),
  entityType: z.string().trim().min(1).max(120).optional(),
  entityId: z.string().trim().min(1).max(200).optional(),
  /// Correlates every row written while serving one request.
  requestId: z.string().trim().min(1).max(120).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;
