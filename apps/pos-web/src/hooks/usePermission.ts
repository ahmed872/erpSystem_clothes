import { useAuthStore } from '../store/authStore';
import type { PermissionCode } from '../lib/apiTypes';

/**
 * Navigation / UX visibility ONLY (Phase 12 rule): hides a button or route
 * a caller's own `GET /permissions/me` says they lack. Never a substitute
 * for server-side authorization — every mutating call below still gets a
 * real 403 from the backend if this check were ever bypassed or stale.
 */
export function usePermission(code: PermissionCode): boolean {
  return useAuthStore((s) => s.permissions.includes(code));
}

export function useHasAnyPermission(codes: PermissionCode[]): boolean {
  return useAuthStore((s) => codes.some((c) => s.permissions.includes(c)));
}
