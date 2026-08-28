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
  // Catalog: Products & Variants
  'products.view',
  'products.view_cost',
  'products.create',
  'products.edit',
  'products.change_price',
  'products.change_cost',
  'products.delete',
  // Catalog: Categories
  'categories.view',
  'categories.create',
  'categories.edit',
  'categories.delete',
  // Catalog: Brands
  'brands.view',
  'brands.create',
  'brands.edit',
  'brands.delete',
  // Catalog: Units of Measure
  'uoms.view',
  'uoms.create',
  'uoms.edit',
  'uoms.delete',
  // Catalog: Attributes
  'attributes.view',
  'attributes.create',
  'attributes.edit',
  'attributes.delete',
  // Catalog: Price Lists
  'pricelists.view',
  'pricelists.create',
  'pricelists.edit',
  'pricelists.manage_prices',
  // Inventory (Phase 3)
  'inventory.view',
  'inventory.opening_stock',
  'inventory.receive',
  'inventory.consume',
  'inventory.adjust',
  'inventory.allow_negative',
  'inventory.transfer_create',
  'inventory.transfer_send',
  'inventory.transfer_receive',
  'inventory.stock_count_create',
  'inventory.stock_count_approve',
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
  // Business Owner always gets every permission that exists, including
  // ones added by later phases — see prisma/seed.ts, which additionally
  // backfills this onto the BUSINESS_OWNER role of businesses that were
  // onboarded before those permissions existed, since a Role's grants are
  // a stored snapshot (RolePermission rows), not computed dynamically.
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
    'products.view',
    'categories.view',
    'brands.view',
    'uoms.view',
    'attributes.view',
    'pricelists.view',
    'inventory.view',
    'inventory.stock_count_approve',
  ],
  ACCOUNTANT: [
    'business.view',
    'branches.view',
    'warehouses.view',
    'audit.view',
    'products.view',
    'products.view_cost',
    'pricelists.view',
    'inventory.view',
  ],
  INVENTORY_MANAGER: [
    'warehouses.view',
    'warehouses.create',
    'warehouses.edit',
    'branches.view',
    'products.view',
    'products.view_cost',
    'products.create',
    'products.edit',
    'products.change_cost',
    'products.delete',
    'categories.view',
    'categories.create',
    'categories.edit',
    'categories.delete',
    'brands.view',
    'brands.create',
    'brands.edit',
    'brands.delete',
    'uoms.view',
    'uoms.create',
    'uoms.edit',
    'uoms.delete',
    'attributes.view',
    'attributes.create',
    'attributes.edit',
    'attributes.delete',
    'pricelists.view',
    'inventory.view',
    'inventory.opening_stock',
    'inventory.receive',
    'inventory.consume',
    'inventory.adjust',
    'inventory.transfer_create',
    'inventory.transfer_send',
    'inventory.transfer_receive',
    'inventory.stock_count_create',
    'inventory.stock_count_approve',
    // Not inventory.allow_negative by default: that's an elevated
    // override even for the Inventory Manager template - the tenant
    // Setting must ALSO be turned on (see resolveAllowNegative), and an
    // owner grants this permission explicitly when they actually want it.
  ],
  CASHIER: ['branches.view', 'products.view', 'inventory.view'],
  SALES_EMPLOYEE: ['branches.view', 'products.view', 'inventory.view'],
};
