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
  // Purchasing (Phase 4): Suppliers
  'suppliers.view',
  'suppliers.create',
  'suppliers.edit',
  'suppliers.delete',
  // Purchasing (Phase 4): Purchases
  'purchases.view',
  'purchases.create',
  'purchases.edit',
  'purchases.approve',
  'purchases.cancel',
  'purchases.receive',
  'purchases.return',
  'purchases.pay',
  // Sales (Phase 5): Customers
  'customers.view',
  'customers.create',
  'customers.edit',
  'customers.delete',
  // Sales (Phase 5): Sales/POS
  'sales.view',
  'sales.create',
  'sales.return',
  'sales.pay',
  // Sales (Phase 5): Shifts
  'shifts.view',
  'shifts.open',
  'shifts.close',
  // Accounting (Phase 6): Chart of Accounts
  'accounting.accounts.view',
  'accounting.accounts.create',
  'accounting.accounts.edit',
  'accounting.accounts.delete',
  // Accounting (Phase 6): Journal / General Ledger
  'accounting.journal.view',
  'accounting.journal.reverse',
  // Accounting (Phase 6): Fiscal Periods
  'accounting.periods.manage',
  'accounting.reopen_period',
  // Reporting (Phase 7) - a strictly read-only layer over the
  // source-of-truth systems. `reports.view_profit` gates profit/margin
  // FIELDS (not whole reports) and is deliberately separate from
  // `products.view_cost`, which continues to gate cost fields.
  'reports.sales.view',
  'reports.inventory.view',
  'reports.financial.view',
  'reports.dashboard.view',
  'reports.view_profit',
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
    'suppliers.view',
    'purchases.view',
    'purchases.approve',
    'purchases.cancel',
    'customers.view',
    'sales.view',
    'sales.return',
    'sales.pay',
    'shifts.view',
    // Reporting (Phase 7): operational oversight for their own branches
    // only (enforced server-side via UserBranch - see branch-scope.ts).
    // Deliberately NOT reports.financial.view and NOT
    // reports.view_profit: a Branch Manager sees operational volume, not
    // the company's financial statements or profit/margin figures.
    'reports.sales.view',
    'reports.inventory.view',
    'reports.dashboard.view',
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
    'suppliers.view',
    'purchases.view',
    'purchases.pay',
    'customers.view',
    'sales.view',
    'sales.pay',
    'shifts.view',
    // Accounting (Phase 6): the Accountant runs the books - full COA and
    // journal access, plus period open/close for month-end/year-end
    // procedures. NOT accounting.reopen_period - reserved for the
    // Business Owner by default (Phase 0 §6.4 names it as a special,
    // separately-granted permission, distinct from ordinary period
    // management), grantable to a specific Accountant explicitly if the
    // owner chooses to.
    'accounting.accounts.view',
    'accounting.accounts.create',
    'accounting.accounts.edit',
    'accounting.accounts.delete',
    'accounting.journal.view',
    'accounting.journal.reverse',
    'accounting.periods.manage',
    // Reporting (Phase 7): the Accountant runs the books, so gets every
    // report including financial statements and profit visibility.
    'reports.sales.view',
    'reports.inventory.view',
    'reports.financial.view',
    'reports.dashboard.view',
    'reports.view_profit',
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
    'suppliers.view',
    'suppliers.create',
    'suppliers.edit',
    'purchases.view',
    'purchases.create',
    'purchases.edit',
    'purchases.receive',
    'purchases.return',
    // Not purchases.approve/cancel/pay/suppliers.delete by default: those
    // are financial-commitment/oversight actions reserved for
    // Branch Manager, Accountant, or Business Owner in this template set.
  ],
  CASHIER: [
    'branches.view',
    'products.view',
    'inventory.view',
    // Deliberately NOT products.view_cost - Phase 0 §9 is explicit that
    // a Cashier must never see cost/profit (بدون رؤية التكلفة/الربح),
    // enforced server-side by stripping cost/margin fields from Sale
    // responses for anyone lacking this permission (see
    // GetSaleUseCase/ListSalesUseCase).
    'customers.view',
    'customers.create',
    'sales.view',
    'sales.create',
    'sales.return',
    'sales.pay',
    'shifts.view',
    'shifts.open',
    'shifts.close',
  ],
  SALES_EMPLOYEE: [
    'branches.view',
    'products.view',
    'inventory.view',
    'customers.view',
    'customers.create',
    'customers.edit',
    'sales.view',
    'sales.create',
    'sales.return',
    'shifts.view',
    'shifts.open',
    'shifts.close',
    // Not sales.pay (collecting a later payment against a credit sale) or
    // products.view_cost by default - matching Phase 0 §9's "بدون تعديل
    // أسعار/تكلفة" (no price/cost editing) posture for this template.
  ],
};
