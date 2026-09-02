import { describe, expect, it } from 'vitest';
import { ERP_NAV, landingRoute, visibleNav } from './navigation';
import type { NavItem } from './navigation';
import { PERMISSION_CODES, ROLE_TEMPLATE_PERMISSIONS } from '@retail/shared-types';

/**
 * Phase 13 (ERP foundation).
 *
 * The assertion that matters most here is a NEGATIVE one, and it is
 * checked directly below: no role name appears anywhere in the navigation
 * map. A tenant may define its own roles, and role templates are seed
 * data, not authorization — a UI that switched on "is a BRANCH_MANAGER"
 * would be reading a job title where the backend reads a grant.
 *
 * The permission sets used below are the LIVE ones from the role
 * templates, so a change to the matrix that broke this app would break
 * these cases too.
 */

/**
 * The permission sets are read from the LIVE role templates rather than
 * typed out here, so a change to the matrix that would change what a role
 * sees in the ERP fails these cases instead of passing them quietly.
 * Tenants may edit their own roles, which is exactly why the app resolves
 * navigation from grants and never from a role name.
 */
const OWNER = [...ROLE_TEMPLATE_PERMISSIONS.BUSINESS_OWNER];
const BRANCH_MANAGER = [...ROLE_TEMPLATE_PERMISSIONS.BRANCH_MANAGER];
const ACCOUNTANT = [...ROLE_TEMPLATE_PERMISSIONS.ACCOUNTANT];
const CASHIER = [...ROLE_TEMPLATE_PERMISSIONS.CASHIER];
const INVENTORY = [...ROLE_TEMPLATE_PERMISSIONS.INVENTORY_MANAGER];

describe('ERP_NAV', () => {
  it('names no role anywhere — authorization is by grant, never by job title', () => {
    const serialized = JSON.stringify(ERP_NAV);
    for (const role of Object.keys(ROLE_TEMPLATE_PERMISSIONS)) {
      expect(serialized).not.toContain(role);
    }
  });

  /**
   * Phase 20 replaced a substring check for the words "role"/"Role" with
   * the assertion it was standing in for. That check could not survive an
   * administration surface — `roles.view` is a permission CODE and
   * `/admin/roles` is a route — and passing it would have meant either
   * dropping the roles screen or naming it something it is not. What
   * actually matters is checked directly instead, and more strictly than
   * before: every code the map gates on is a real code in the live
   * catalogue, so nothing here can be a role name, a job title, or a
   * typo that silently hides a destination from everyone.
   */
  it('gates only on codes that exist in the live permission catalogue', () => {
    const catalogue = new Set<string>(PERMISSION_CODES);
    for (const item of ERP_NAV) {
      for (const code of [...item.requires, ...(item.requiresAny ?? [])]) {
        expect(catalogue.has(code)).toBe(true);
      }
    }
  });

  it('labels every entry with an i18n key, never a literal — Arabic is the default', () => {
    for (const item of ERP_NAV) {
      expect(item.labelKey).toMatch(/^nav\./);
    }
  });

  it('leaves no entry ungated: every destination demands at least one grant', () => {
    // Either list satisfies this. `/setup` gates with `requiresAny`
    // because it fronts five separately-granted things; the rest use
    // `requires`. What must never appear is an entry demanding nothing.
    for (const item of ERP_NAV) {
      expect(item.requires.length + (item.requiresAny?.length ?? 0)).toBeGreaterThan(0);
    }
  });
});

describe('visibleNav', () => {
  it('gives an owner every destination in the product so far', () => {
    expect(visibleNav(OWNER).map((i) => i.to)).toEqual([
      '/dashboard',
      '/catalogue',
      '/price-lists',
      '/inventory',
      '/inventory/transfers',
      '/sales',
      '/customers',
      '/purchases',
      '/suppliers',
      '/setup',
      '/reports/sales',
      '/reports/purchasing',
      '/reports/inventory',
      '/reports/financial',
      '/reports/reconciliation',
      '/warranty-claims',
      '/shifts',
      '/admin/users',
      '/admin/roles',
      '/admin/organisation',
      '/admin/business',
      '/admin/tax',
      '/admin/audit-log',
    ]);
  });

  it('gives a cashier no dashboard — a till has no `reports.dashboard.view`', () => {
    // The POS/ERP split proved as data. A cashier DOES hold `shifts.view`
    // (they read their own drawer at the till), so the shift list appears
    // — but whether they may RECONCILE one is `shifts.reconcile`, which
    // they do not hold, and which the page checks separately.
    // A cashier holds `products.view`, so the catalogue is readable to
    // them — but they hold no create/edit/price grant, and every control
    // on those screens is gated separately.
    // A cashier also holds `inventory.view`, so stock is readable to
    // them — every mutation on those screens is a separate grant they do
    // not hold, and the backend refuses each one regardless.
    expect(visibleNav(CASHIER).map((i) => i.to)).toEqual([
      '/catalogue',
      '/inventory',
      '/inventory/transfers',
      '/sales',
      '/customers',
      '/warranty-claims',
      '/shifts',
      // Phase 20. A cashier holds `branches.view` and nothing else
      // administrative, so the organisation entry appears and its
      // warehouses TAB does not — the same requiresAny shape reference
      // data uses. No users, roles, business, tax or audit surface.
      '/admin/organisation',
    ]);
    expect(CASHIER).not.toContain('users.view');
    expect(CASHIER).not.toContain('roles.view');
    expect(CASHIER).not.toContain('audit.view');
    expect(CASHIER).not.toContain('business.view');
    expect(CASHIER).not.toContain('tax.view');
    expect(CASHIER).not.toContain('inventory.adjust');
    // A till has no purchasing surface whatever.
    expect(CASHIER).not.toContain('purchases.view');
    expect(CASHIER).not.toContain('suppliers.view');
    expect(CASHIER).not.toContain('inventory.transfer_create');
    expect(CASHIER).not.toContain('warehouses.view');
    expect(CASHIER).not.toContain('shifts.reconcile');
    expect(CASHIER).not.toContain('products.edit');
    expect(CASHIER).not.toContain('pricelists.view');
    // Phase 17. A cashier DOES hold `sales.view` — they look up a receipt
    // they rang up themselves — so the sales entry appears for them, and
    // they hold `sales.pay` too, because taking money on an account sale
    // is the till's own job. What the sale screens still withhold from
    // them is cost and profit: those are `products.view_cost`, which the
    // server checks before it attaches the keys at all.
    expect(CASHIER).toContain('sales.view');
    expect(CASHIER).toContain('sales.pay');
    // Phase 18. A till creates customers, so a cashier holds
    // `customers.view` and `customers.create` — but not `customers.edit`
    // or `customers.delete`, which is why those controls do not render
    // for them and the backend refuses them regardless.
    expect(CASHIER).toContain('customers.create');
    expect(CASHIER).not.toContain('customers.edit');
    expect(CASHIER).not.toContain('customers.delete');
    expect(CASHIER).not.toContain('products.view_cost');
  });

  it('gives a branch manager every destination, and no cost or profit grant with them', () => {
    expect(visibleNav(BRANCH_MANAGER).map((i) => i.to)).toEqual([
      '/dashboard',
      '/catalogue',
      '/price-lists',
      '/inventory',
      '/inventory/transfers',
      '/sales',
      '/customers',
      '/purchases',
      '/suppliers',
      '/setup',
      '/reports/sales',
      '/reports/purchasing',
      '/reports/inventory',
      '/reports/reconciliation',
      '/warranty-claims',
      '/shifts',
      // Phase 20. A branch manager administers PEOPLE but not the
      // permission model: they hold `users.view` and no `roles.view`, so
      // the roles entry is absent while the users entry is present.
      '/admin/users',
      '/admin/organisation',
      '/admin/business',
      '/admin/tax',
      '/admin/audit-log',
    ]);
    expect(BRANCH_MANAGER).toContain('users.view');
    expect(BRANCH_MANAGER).not.toContain('roles.view');
    expect(BRANCH_MANAGER).not.toContain('roles.edit');
    // The reason the dashboard renders different tiles for this role: the
    // server deletes the cost and profit keys from their response.
    expect(BRANCH_MANAGER).not.toContain('products.view_cost');
    expect(BRANCH_MANAGER).not.toContain('reports.view_profit');
    // Phase 19. They read the sales and inventory reports and are refused
    // the financial ones outright, which is why `/reports/financial` is
    // absent above while `/reports/reconciliation` is present: that entry
    // is reachable on EITHER report grant and each tab re-checks its own.
    expect(BRANCH_MANAGER).not.toContain('reports.financial.view');
    expect(BRANCH_MANAGER).toContain('reports.sales.view');
    expect(BRANCH_MANAGER).toContain('reports.inventory.view');
  });

  it('gives an accountant all three: `warranty.claim` gates the CONTROL, not the screen', () => {
    // An accountant reads claim history and audits it; deciding a claim is
    // a separate grant they do not hold.
    expect(ACCOUNTANT).not.toContain('warranty.claim');
    // `warranty.view` is what the route needs. Whether the resolve button
    // appears is a separate question, answered by usePermission on the
    // page — conflating them would hide claim history from the people who
    // audit it.
    expect(visibleNav(ACCOUNTANT).map((i) => i.to)).toEqual([
      '/dashboard',
      '/catalogue',
      '/price-lists',
      '/inventory',
      '/inventory/transfers',
      '/sales',
      '/customers',
      '/purchases',
      '/suppliers',
      '/setup',
      '/reports/sales',
      '/reports/purchasing',
      '/reports/inventory',
      '/reports/financial',
      '/reports/reconciliation',
      '/warranty-claims',
      '/shifts',
      // Phase 20. An accountant reads the organisation, the business
      // profile, the tax settings and the trail — and administers
      // neither users nor roles.
      '/admin/organisation',
      '/admin/business',
      '/admin/tax',
      '/admin/audit-log',
    ]);
    expect(ACCOUNTANT).not.toContain('users.view');
    expect(ACCOUNTANT).not.toContain('roles.view');
    expect(ACCOUNTANT).toContain('audit.view');
  });

  it('finally gives an INVENTORY_MANAGER a back office — Phase 13 gave them none', () => {
    // The role that builds the catalogue held none of Slice 1's three
    // grants and landed on /no-access. Phase 14 is the milestone that is
    // actually theirs.
    expect(visibleNav(INVENTORY).map((i) => i.to)).toEqual([
      '/catalogue',
      '/price-lists',
      '/inventory',
      '/inventory/transfers',
      '/purchases',
      '/suppliers',
      '/setup',
      // Phase 20. Stock lives in warehouses, so they read the
      // organisation; they hold `tax.view` (a product carries a tax) but
      // no `tax.manage`, and the tax settings screen renders read-only
      // for them. No users, roles, business profile or audit trail.
      '/admin/organisation',
      '/admin/tax',
    ]);
    expect(INVENTORY).toContain('warehouses.view');
    expect(INVENTORY).toContain('tax.view');
    expect(INVENTORY).not.toContain('tax.manage');
    expect(INVENTORY).not.toContain('users.view');
    expect(INVENTORY).not.toContain('roles.view');
    expect(INVENTORY).not.toContain('business.view');
    expect(INVENTORY).not.toContain('audit.view');
    expect(INVENTORY).toContain('products.create');
    expect(INVENTORY).toContain('products.change_cost');
    // ...but NOT the shelf price, and NOT the ability to reprice the shop.
    expect(INVENTORY).not.toContain('products.change_price');
    expect(INVENTORY).not.toContain('pricelists.manage_prices');
    // Phase 16's separation of duties: they raise and receive orders but
    // neither commit the business to one nor settle it.
    expect(INVENTORY).toContain('purchases.create');
    expect(INVENTORY).toContain('purchases.receive');
    expect(INVENTORY).not.toContain('purchases.approve');
    expect(INVENTORY).not.toContain('purchases.pay');
    // Phase 17. Stock is theirs; the sales ledger is not — which is why
    // no `/sales` entry appears in their navigation above.
    expect(INVENTORY).not.toContain('sales.view');
    // Phase 18, the same line drawn again: they hold no customer surface
    // either, which is why no `/customers` entry appears above.
    expect(INVENTORY).not.toContain('customers.view');
    // Phase 19. They hold `products.view_cost` but NO report grant at
    // all, which is the distinction that matters: cost visibility is not
    // reporting access, and no `/reports/*` entry appears for them.
    expect(INVENTORY).toContain('products.view_cost');
    expect(INVENTORY).not.toContain('reports.inventory.view');
    expect(INVENTORY).not.toContain('reports.sales.view');
    expect(INVENTORY).not.toContain('reports.financial.view');
  });

  it('splits purchasing across three roles — nobody can run an order alone', () => {
    // The matrix, asserted as data: raising, approving and paying are
    // held by three different roles, which is why the detail screen
    // renders one control per grant rather than one "process" button.
    expect(INVENTORY).toContain('purchases.create');
    expect(BRANCH_MANAGER).toContain('purchases.approve');
    expect(ACCOUNTANT).toContain('purchases.pay');

    expect(BRANCH_MANAGER).not.toContain('purchases.create');
    expect(BRANCH_MANAGER).not.toContain('purchases.receive');
    expect(BRANCH_MANAGER).not.toContain('purchases.pay');
    expect(ACCOUNTANT).not.toContain('purchases.create');
    expect(ACCOUNTANT).not.toContain('purchases.approve');
    expect(ACCOUNTANT).not.toContain('purchases.receive');
  });

  it('requires ALL codes on an entry, not any of them', () => {
    const items: NavItem[] = [{ to: '/x', labelKey: 'nav.x', requires: ['a', 'b'] }];
    expect(visibleNav(['a'], items)).toEqual([]);
    expect(visibleNav(['a', 'b'], items)).toEqual(items);
  });

  it('is unaffected by grants it does not ask for', () => {
    expect(visibleNav(['shifts.view', 'inventory.receive']).map((i) => i.to)).toEqual(['/shifts']);
  });

  it('shows the setup entry for ANY one of the five things behind it', () => {
    // `requiresAny`. Reference data fronts five separately-granted things;
    // requiring all of them would hide the tax screen from the ACCOUNTANT,
    // who holds `tax.manage` and none of the other four.
    for (const grant of ['categories.view', 'brands.view', 'attributes.view', 'uoms.view']) {
      expect(visibleNav([grant]).map((i) => i.to)).toEqual(['/setup']);
    }
    // `tax.view` reaches the setup screen AND, since Phase 20, the tax
    // settings screen: the rate table and the business's pricing mode are
    // two different things behind the same read grant.
    expect(visibleNav(['tax.view']).map((i) => i.to)).toEqual(['/setup', '/admin/tax']);
  });

  /**
   * Phase 20 — administration, as data.
   *
   * Each entry appears for exactly the grant its route and its endpoints
   * demand, and organisation appears on EITHER of the two grants behind
   * it with each tab re-checking its own.
   */
  it('shows each administration entry for exactly its own grant', () => {
    expect(visibleNav(['users.view']).map((i) => i.to)).toEqual(['/admin/users']);
    expect(visibleNav(['roles.view']).map((i) => i.to)).toEqual(['/admin/roles']);
    expect(visibleNav(['business.view']).map((i) => i.to)).toEqual(['/admin/business']);
    expect(visibleNav(['audit.view']).map((i) => i.to)).toEqual(['/admin/audit-log']);
  });

  it('shows the organisation entry on EITHER branches or warehouses', () => {
    expect(visibleNav(['branches.view']).map((i) => i.to)).toEqual(['/admin/organisation']);
    expect(visibleNav(['warehouses.view']).map((i) => i.to)).toEqual(['/admin/organisation']);
    expect(visibleNav(['branches.view', 'warehouses.view']).map((i) => i.to)).toEqual(['/admin/organisation']);
  });

  it('hides every administration entry from an account holding none of their grants', () => {
    expect(visibleNav(['products.view']).map((i) => i.to)).toEqual(['/catalogue']);
  });

  it('does not let an EDIT grant alone reveal a screen — the READ grant is what shows it', () => {
    // `roles.edit` without `roles.view` is a set nobody is seeded with,
    // but a tenant can build it. The entry stays hidden, and the backend
    // refuses the list call regardless.
    expect(visibleNav(['roles.edit']).map((i) => i.to)).toEqual([]);
    expect(visibleNav(['users.edit']).map((i) => i.to)).toEqual([]);
    expect(visibleNav(['business.edit']).map((i) => i.to)).toEqual([]);
    expect(visibleNav(['tax.manage']).map((i) => i.to)).toEqual([]);
  });

  it('hides the setup entry when NONE of the five is held', () => {
    expect(visibleNav(['products.view']).map((i) => i.to)).toEqual(['/catalogue']);
    expect(visibleNav(['inventory.view']).map((i) => i.to)).toEqual(['/inventory', '/inventory/transfers']);
    expect(visibleNav(['sales.view']).map((i) => i.to)).toEqual(['/sales']);
    expect(visibleNav(['customers.view']).map((i) => i.to)).toEqual(['/customers']);
    // Phase 19. Each report grant reaches exactly its own screens, and
    // the reconciliation entry appears on either of the two.
    expect(visibleNav(['reports.sales.view']).map((i) => i.to)).toEqual(['/reports/sales', '/reports/purchasing']);
    expect(visibleNav(['reports.inventory.view']).map((i) => i.to)).toEqual(['/reports/inventory', '/reports/reconciliation']);
    expect(visibleNav(['reports.financial.view']).map((i) => i.to)).toEqual(['/reports/financial', '/reports/reconciliation']);
    expect(visibleNav(['purchases.view']).map((i) => i.to)).toEqual(['/purchases']);
    expect(visibleNav(['suppliers.view']).map((i) => i.to)).toEqual(['/suppliers']);
  });

  it('applies requires AND requiresAny together, not either alone', () => {
    const items: NavItem[] = [{ to: '/x', labelKey: 'nav.x', requires: ['must'], requiresAny: ['a', 'b'] }];
    expect(visibleNav(['must'], items)).toEqual([]);
    expect(visibleNav(['a'], items)).toEqual([]);
    expect(visibleNav(['must', 'b'], items)).toEqual(items);
  });

  it('preserves the declared order rather than the order permissions arrived in', () => {
    expect(visibleNav([...OWNER].reverse()).map((i) => i.to)).toEqual(visibleNav(OWNER).map((i) => i.to));
  });
});

describe('landingRoute', () => {
  it('sends an owner to the dashboard', () => {
    expect(landingRoute(OWNER)).toBe('/dashboard');
  });

  it('sends a user WITHOUT the dashboard grant to the first module they can reach', () => {
    // Never a constant `/dashboard`: that would redirect a shifts-only
    // user straight back out and read as a broken product.
    expect(landingRoute(['shifts.view'])).toBe('/shifts');
    expect(landingRoute(['warranty.view'])).toBe('/warranty-claims');
    // A cashier holds `products.view`, so the catalogue is the first
    // module they reach — the landing route follows the declared order,
    // not a guess about which screen suits the role.
    expect(landingRoute(CASHIER)).toBe('/catalogue');
  });

  it('sends an inventory-only account to the stock screen', () => {
    expect(landingRoute(['inventory.view'])).toBe('/inventory');
  });

  it('sends an INVENTORY_MANAGER to the catalogue — their first reachable module', () => {
    expect(landingRoute(INVENTORY)).toBe('/catalogue');
  });

  it('sends a branch manager and an accountant to the dashboard they both hold', () => {
    expect(landingRoute(BRANCH_MANAGER)).toBe('/dashboard');
    expect(landingRoute(ACCOUNTANT)).toBe('/dashboard');
  });

  it('returns null — not a route — when the account has no ERP surface', () => {
    expect(landingRoute(['inventory.receive'])).toBeNull();
    expect(landingRoute([])).toBeNull();
  });
});
