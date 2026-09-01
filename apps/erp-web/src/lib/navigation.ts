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
  { to: '/warranty-claims', labelKey: 'nav.warrantyClaims', requires: ['warranty.view'] },
  { to: '/shifts', labelKey: 'nav.shifts', requires: ['shifts.view'] },
];

/** The entries this caller may see. */
export function visibleNav(permissions: PermissionCode[], items: NavItem[] = ERP_NAV): NavItem[] {
  const held = new Set(permissions);
  return items.filter((item) => item.requires.every((code) => held.has(code)));
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
