import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useShiftStore } from '../store/shiftStore';

/** UX routing only — every page below still calls real, permission-gated
 * endpoints; a guard here just avoids flashing a screen the user cannot
 * use. Losing the token client-side is not what makes a route safe. */
export function RequireAuth() {
  const accessToken = useAuthStore((s) => s.accessToken);
  if (!accessToken) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export function RequireShift() {
  const activeShift = useShiftStore((s) => s.activeShift);
  if (!activeShift) return <Navigate to="/shift-setup" replace />;
  return <Outlet />;
}
