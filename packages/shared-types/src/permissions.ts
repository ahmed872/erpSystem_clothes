/**
 * Canonical permission codes (resource.action). This list is the single
 * source of truth shared between the API (seeding + guards) and any
 * frontend that needs to gate UI affordances. Server-side enforcement is
 * always authoritative — see apps/api PermissionsGuard.
 */
export const PERMISSION_CODES = [
  // Users
  'users.view',
  'users.create',
  'users.edit',
  'users.delete',
  'users.manage_roles',
  // Roles & Permissions
  'roles.view',
  'roles.create',
  'roles.edit',
  'roles.delete',
  'permissions.view',
  // Business / Settings
  'business.view',
  'business.edit',
  'settings.view',
  'settings.edit',
  // Branches
  'branches.view',
  'branches.create',
  'branches.edit',
  'branches.delete',
  // Warehouses
  'warehouses.view',
  'warehouses.create',
  'warehouses.edit',
  'warehouses.delete',
  // Audit
  'audit.view',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export const ROLE_TEMPLATES = [
  'BUSINESS_OWNER',
  'BRANCH_MANAGER',
  'ACCOUNTANT',
  'INVENTORY_MANAGER',
  'CASHIER',
  'SALES_EMPLOYEE',
] as const;

export type RoleTemplate = (typeof ROLE_TEMPLATES)[number];

/**
 * Default permission grants per built-in role template. Tenants may add
 * custom roles / adjust grants later (Phase 2+); these are only the
 * starting defaults created at business onboarding.
 */
export const ROLE_TEMPLATE_PERMISSIONS: Record<RoleTemplate, PermissionCode[]> = {
  BUSINESS_OWNER: [...PERMISSION_CODES],
  BRANCH_MANAGER: [
    'users.view',
    'branches.view',
    'branches.edit',
    'warehouses.view',
    'warehouses.create',
    'warehouses.edit',
    'business.view',
    'settings.view',
    'audit.view',
  ],
  ACCOUNTANT: ['business.view', 'branches.view', 'warehouses.view', 'audit.view'],
  INVENTORY_MANAGER: ['warehouses.view', 'warehouses.create', 'warehouses.edit', 'branches.view'],
  CASHIER: ['branches.view'],
  SALES_EMPLOYEE: ['branches.view'],
};
