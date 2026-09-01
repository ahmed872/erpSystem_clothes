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
      expect(item.requires.length).toBeGreaterThan(0);
    }
  });
});

describe('visibleNav', () => {
  it('gives an owner every destination in this milestone', () => {
    expect(visibleNav(OWNER).map((i) => i.to)).toEqual(['/dashboard', '/warranty-claims', '/shifts']);
  });

  it('gives a cashier no dashboard — a till has no `reports.dashboard.view`', () => {
    // The POS/ERP split proved as data. A cashier DOES hold `shifts.view`
    // (they read their own drawer at the till), so the shift list appears
    // — but whether they may RECONCILE one is `shifts.reconcile`, which
    // they do not hold, and which the page checks separately.
    expect(visibleNav(CASHIER).map((i) => i.to)).toEqual(['/warranty-claims', '/shifts']);
    expect(CASHIER).not.toContain('shifts.reconcile');
  });

  it('gives a branch manager all three, and no cost or profit grant with them', () => {
    expect(visibleNav(BRANCH_MANAGER).map((i) => i.to)).toEqual(['/dashboard', '/warranty-claims', '/shifts']);
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
    expect(visibleNav(ACCOUNTANT).map((i) => i.to)).toEqual(['/dashboard', '/warranty-claims', '/shifts']);
  });

  it('gives an inventory manager nothing at all rather than an empty shell', () => {
    expect(visibleNav(INVENTORY)).toEqual([]);
  });

  it('requires ALL codes on an entry, not any of them', () => {
    const items: NavItem[] = [{ to: '/x', labelKey: 'nav.x', requires: ['a', 'b'] }];
    expect(visibleNav(['a'], items)).toEqual([]);
    expect(visibleNav(['a', 'b'], items)).toEqual(items);
  });

  it('is unaffected by grants it does not ask for', () => {
    expect(visibleNav([...INVENTORY, 'shifts.view']).map((i) => i.to)).toEqual(['/shifts']);
  });

  it('preserves the declared order rather than the order permissions arrived in', () => {
    expect(visibleNav([...OWNER].reverse()).map((i) => i.to)).toEqual(['/dashboard', '/warranty-claims', '/shifts']);
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
    expect(landingRoute(CASHIER)).toBe('/warranty-claims');
  });

  it('sends a branch manager and an accountant to the dashboard they both hold', () => {
    expect(landingRoute(BRANCH_MANAGER)).toBe('/dashboard');
    expect(landingRoute(ACCOUNTANT)).toBe('/dashboard');
  });

  it('returns null — not a route — when the account has no ERP surface', () => {
    expect(landingRoute(INVENTORY)).toBeNull();
    expect(landingRoute([])).toBeNull();
  });
});
