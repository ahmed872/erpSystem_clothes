import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

/**
 * Authentication gate. UX only — every route behind it is independently
 * guarded server-side, so this just avoids flashing a screen the caller
 * cannot use.
 */
export function RequireAuth() {
  const accessToken = useAuthStore((s) => s.accessToken);
  if (!accessToken) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/**
 * Permission gate for a single ERP route.
 *
 * VISIBILITY, NOT AUTHORIZATION. A caller who reaches the URL directly
 * without the grant is redirected instead of being shown a broken screen;
 * had they got through, the backend would refuse every call the page makes.
 */
export function RequirePermission({ codes, fallback }: { codes: string[]; fallback: string }) {
  const permissions = useAuthStore((s) => s.permissions);
  const held = new Set(permissions);
  if (!codes.every((c) => held.has(c))) return <Navigate to={fallback} replace />;
  return <Outlet />;
}

/**
 * Phase 14 — a route that fronts several independently-granted sections.
 *
 * Reference data is the case: categories, brands, attributes, units and
 * taxes each carry their own grants, and an ACCOUNTANT holds `tax.manage`
 * and none of the other four. Requiring all of them would lock the tax
 * screen away from the role that manages tax. So the route admits anyone
 * holding AT LEAST ONE, and each tab inside re-checks its own — which is
 * still visibility only, since the backend refuses every call regardless.
 */
export function RequireAnyPermission({ codes, fallback }: { codes: string[]; fallback: string }) {
  const permissions = useAuthStore((s) => s.permissions);
  const held = new Set(permissions);
  if (!codes.some((c) => held.has(c))) return <Navigate to={fallback} replace />;
  return <Outlet />;
}
