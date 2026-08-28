import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(255);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a digit');

export const nameSchema = z.string().trim().min(1).max(120);

export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens');

export const currencyCodeSchema = z
  .string()
  .trim()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO 4217 code');

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
