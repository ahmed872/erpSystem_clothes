import { z } from 'zod';
import { emailSchema, nameSchema, slugSchema, currencyCodeSchema, passwordSchema } from './primitives';

export * from './primitives';
export * from './catalog';
export * from './inventory';
export * from './purchasing';

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
});
export type RegisterBusinessInput = z.infer<typeof registerBusinessSchema>;

export const updateBusinessSchema = z.object({
  name: nameSchema.optional(),
  currency: currencyCodeSchema.optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
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
