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
  // Sales (Phase 10, BLOCKING-2): park a basket and pick it up again.
  // ONE code covers hold, resume and void: they are the same act from the
  // till's point of view, and a cashier who can park a basket is exactly
  // the person who has to be able to abandon it. Resuming ALSO requires
  // `sales.create`, because resuming really does create a sale.
  'sales.hold',
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
  // Warranty (Phase 8A) - record-keeping only: registering a warranty or
  // a claim never touches inventory or accounting.
  'warranty.view',
  'warranty.register',
  'warranty.claim',
  // Loyalty (Phase 8B) - an append-only points ledger. `loyalty.view`
  // reads a customer's derived balance and ledger history;
  // `loyalty.adjust` is the one human-entered write, deliberately held to
  // Owner/Accountant since a manual point grant is a monetary-value
  // decision with no source document behind it.
  'loyalty.view',
  'loyalty.adjust',
  // Promotions (Phase 8D) - authoring a discount rule is a pricing
  // decision, so create/edit/deactivate are Owner-only by default. Every
  // POS-facing role gets `promotions.view` so a cashier can see WHY a
  // price dropped without being able to author the rule.
  'promotions.view',
  'promotions.create',
  'promotions.edit',
  'promotions.deactivate',
  // Cash registers & till (Phase 10, BD-17)
  'cash_registers.view',
  'cash_registers.manage',
  'shifts.reconcile',
  /// Gates the EXPECTED cash figure itself. Without this permission the
  /// server OMITS expected/variance from every shift response - which is
  /// what makes BLIND CLOSE real rather than a screen that chooses not to
  /// look. Same server-side stripping posture as products.view_cost.
  'shifts.view_expected',
  'cash.movement',
  // Tax configuration (Phase 10, BD-18)
  'tax.view',
  'tax.manage',
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
    // Warranty (Phase 8A): full operational handling for their branches'
    // customers - register, view, and process claims.
    'warranty.view',
    'warranty.register',
    'warranty.claim',
    // Loyalty (Phase 8B): read-only. Adjusting points by hand is not a
    // branch-level decision - it is deliberately Owner/Accountant only.
    'loyalty.view',
    // Promotions (Phase 8D): read-only. Promotions are tenant-wide in
    // Phase 8 (branch-scoped promotions are deferred), so authoring one
    // is not a branch-level act.
    'promotions.view',
    // Cash/till (Phase 10, BD-17): the Branch Manager is the reconciling
    // authority for their branch's tills - they define registers, see the
    // expected figure, and acknowledge variances.
    'cash_registers.view',
    'cash_registers.manage',
    'shifts.reconcile',
    'shifts.view_expected',
    'cash.movement',
    'tax.view',
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
    // Warranty (Phase 8A): read-only oversight. An Accountant does not
    // register warranties or process claims at the counter.
    'warranty.view',
    // Loyalty (Phase 8B): full ledger oversight INCLUDING manual
    // adjustment - a point correction is a value decision of the same
    // kind as the customer-ledger corrections this role already owns.
    'loyalty.view',
    'loyalty.adjust',
    // Promotions (Phase 8D): read-only oversight - an Accountant needs to
    // explain a discounted sale, not to author discount rules.
    'promotions.view',
    // Cash/till (Phase 10, BD-17): full oversight including the expected
    // figure and variance acknowledgement - a cash variance is a value
    // decision of the same kind as the ledger corrections this role owns.
    // NOT cash_registers.manage: defining a physical till is a branch
    // operations act, not an accounting one.
    'cash_registers.view',
    'shifts.reconcile',
    'shifts.view_expected',
    'cash.movement',
    // Tax is an accounting configuration decision, so the Accountant may
    // author it as well as read it.
    'tax.view',
    'tax.manage',
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
    // Assigning a tax to a product is part of setting the product up.
    'tax.view',
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
    'sales.hold',
    'sales.return',
    'sales.pay',
    'shifts.view',
    'shifts.open',
    'shifts.close',
    // Warranty (Phase 8A): POS-floor actions - register a warranty at the
    // till and take a claim over the counter. Warranty carries no cost or
    // profit information, so this does not breach the Cashier's
    // no-cost-visibility rule above.
    'warranty.view',
    'warranty.register',
    'warranty.claim',
    // Loyalty (Phase 8B): a cashier must be able to tell a customer their
    // point balance at the till, but NOT hand out points by hand.
    'loyalty.view',
    // Promotions (Phase 8D): read-only - explain the price at the till,
    // never author the rule behind it. Selling WITH a promotion applied
    // needs no promotion permission at all: resolution is server-side
    // inside CreateSaleUseCase and is gated by `sales.create`.
    'promotions.view',
    // Cash/till (Phase 10, BD-17): a cashier picks their register, records
    // drawer movements, and closes BLIND. Deliberately NOT
    // shifts.view_expected - seeing the expected figure before counting is
    // exactly what blind close exists to prevent - and NOT shifts.reconcile,
    // which is the reviewing manager's act, not the counted party's.
    'cash_registers.view',
    'cash.movement',
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
    'sales.hold',
    'sales.return',
    'shifts.view',
    'shifts.open',
    'shifts.close',
    // Not sales.pay (collecting a later payment against a credit sale) or
    // products.view_cost by default - matching Phase 0 §9's "بدون تعديل
    // أسعار/تكلفة" (no price/cost editing) posture for this template.
    // Warranty (Phase 8A): can register a warranty when selling, but NOT
    // warranty.claim - processing a claim is a decision reserved for a
    // Cashier/Branch Manager/Owner in this template set.
    'warranty.view',
    'warranty.register',
    // Loyalty (Phase 8B): read-only, same reasoning as the Cashier.
    'loyalty.view',
    // Promotions (Phase 8D): read-only, same reasoning as the Cashier.
    'promotions.view',
    // Cash/till (Phase 10, BD-17): can select a register and close blind,
    // like a Cashier. NOT cash.movement - recording a pay-in or pay-out is
    // a till-custody act reserved for the Cashier in this template set,
    // matching this role's existing exclusion from sales.pay.
    'cash_registers.view',
  ],
};
