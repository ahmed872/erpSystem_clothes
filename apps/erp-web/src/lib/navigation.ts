import type { PermissionCode } from './apiTypes';

/**
 * Phase 13 (ERP foundation) — WHAT THIS USER'S ERP LOOKS LIKE.
 *
 * The back office has many more destinations than a till, and no two roles
 * see the same ones: an ACCOUNTANT holds `shifts.reconcile` but not
 * `warranty.claim`; a BRANCH_MANAGER holds both but neither
 * `reports.view_profit` nor `products.view_cost`; an INVENTORY_MANAGER
 * holds none of the three and must not be shown an empty shell.
 *
 * So navigation is DATA, resolved from the caller's own effective
 * permissions, rather than a hand-maintained list of `&&`s in the shell.
 * Roles are never named here: a tenant may define custom roles, and a UI
 * that switched on "is a BRANCH_MANAGER" would be authorizing by job title
 * instead of by grant.
 *
 * VISIBILITY ONLY. Every route behind these entries is guarded server-side
 * on the same permission; hiding an item stops a pointless 403, it does not
 * grant or withhold anything. `requires` is ALL-of: an entry appears only
 * when the caller holds every code it lists.
 */
export interface NavItem {
  to: string;
  /** i18n key, never a literal — Arabic is the default language. */
  labelKey: string;
  /** Every code must be held for this entry to appear. */
  requires: PermissionCode[];
  /**
   * Phase 14 — at least ONE of these must be held, in addition to
   * everything in `requires`.
   *
   * Needed because one destination can front several independently-granted
   * things. Reference data is the case: categories, brands, attributes,
   * units and taxes each have their own grants, and an ACCOUNTANT holds
   * `tax.manage` and none of the other four. Requiring all of them would
   * hide the tax screen from the very role that manages tax; requiring
   * none would show an empty page to someone who holds nothing. So the
   * entry appears when any one tab behind it is reachable, and each TAB
   * re-checks its own grant.
   */
  requiresAny?: PermissionCode[];
}

/**
 * The ERP's destinations, in the order a back-office user meets them.
 *
 * This milestone deliberately registers THREE. Later ERP milestones append
 * here; nothing else in the shell changes when they do, which is the point
 * of keeping the map in one place.
 */
export const ERP_NAV: NavItem[] = [
  { to: '/dashboard', labelKey: 'nav.dashboard', requires: ['reports.dashboard.view'] },
  { to: '/catalogue', labelKey: 'nav.catalogue', requires: ['products.view'] },
  { to: '/price-lists', labelKey: 'nav.priceLists', requires: ['pricelists.view'] },
  { to: '/inventory', labelKey: 'nav.inventory', requires: ['inventory.view'] },
  { to: '/inventory/transfers', labelKey: 'nav.transfers', requires: ['inventory.view'] },
  { to: '/purchases', labelKey: 'nav.purchases', requires: ['purchases.view'] },
  { to: '/suppliers', labelKey: 'nav.suppliers', requires: ['suppliers.view'] },
  {
    to: '/setup',
    labelKey: 'nav.setup',
    requires: [],
    requiresAny: ['categories.view', 'brands.view', 'attributes.view', 'uoms.view', 'tax.view'],
  },
  { to: '/warranty-claims', labelKey: 'nav.warrantyClaims', requires: ['warranty.view'] },
  { to: '/shifts', labelKey: 'nav.shifts', requires: ['shifts.view'] },
];

/** The entries this caller may see. */
export function visibleNav(permissions: PermissionCode[], items: NavItem[] = ERP_NAV): NavItem[] {
  const held = new Set(permissions);
  return items.filter(
    (item) =>
      item.requires.every((code) => held.has(code)) &&
      (item.requiresAny === undefined || item.requiresAny.some((code) => held.has(code))),
  );
}

/**
 * Where to send someone who has just signed in, or who typed `/`.
 *
 * The first destination they can actually reach — never a hardcoded
 * `/dashboard`, because a user without `reports.dashboard.view` would be
 * bounced straight into a 403 and conclude the product is broken. `null`
 * means this account has no ERP surface at all, which the shell says
 * plainly rather than showing an empty frame.
 */
export function landingRoute(permissions: PermissionCode[], items: NavItem[] = ERP_NAV): string | null {
  return visibleNav(permissions, items)[0]?.to ?? null;
}
