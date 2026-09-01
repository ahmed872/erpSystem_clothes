import { describe, expect, it } from 'vitest';
import { ERP_NAV, landingRoute, visibleNav } from './navigation';
import type { NavItem } from './navigation';
import { ROLE_TEMPLATE_PERMISSIONS } from '@retail/shared-types';

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
    for (const role of ['BUSINESS_OWNER', 'BRANCH_MANAGER', 'ACCOUNTANT', 'INVENTORY_MANAGER', 'CASHIER', 'role', 'Role']) {
      expect(serialized).not.toContain(role);
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
      '/purchases',
      '/suppliers',
      '/setup',
      '/warranty-claims',
      '/shifts',
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
      '/warranty-claims',
      '/shifts',
    ]);
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
      '/purchases',
      '/suppliers',
      '/setup',
      '/warranty-claims',
      '/shifts',
    ]);
    // The reason the dashboard renders different tiles for this role: the
    // server deletes the cost and profit keys from their response.
    expect(BRANCH_MANAGER).not.toContain('products.view_cost');
    expect(BRANCH_MANAGER).not.toContain('reports.view_profit');
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
      '/purchases',
      '/suppliers',
      '/setup',
      '/warranty-claims',
      '/shifts',
    ]);
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
    ]);
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
    for (const grant of ['categories.view', 'brands.view', 'attributes.view', 'uoms.view', 'tax.view']) {
      expect(visibleNav([grant]).map((i) => i.to)).toEqual(['/setup']);
    }
  });

  it('hides the setup entry when NONE of the five is held', () => {
    expect(visibleNav(['products.view']).map((i) => i.to)).toEqual(['/catalogue']);
    expect(visibleNav(['inventory.view']).map((i) => i.to)).toEqual(['/inventory', '/inventory/transfers']);
    expect(visibleNav(['sales.view']).map((i) => i.to)).toEqual(['/sales']);
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
