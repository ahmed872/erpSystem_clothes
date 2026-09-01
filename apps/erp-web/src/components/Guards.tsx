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
