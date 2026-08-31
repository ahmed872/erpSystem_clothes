import { permissionsApi } from '../api/permissions';
import { shiftsApi } from '../api/shifts';
import { useAuthStore } from '../store/authStore';
import { useShiftStore } from '../store/shiftStore';

/**
 * Re-validates the caller's effective permissions (BLOCKING-A) and their
 * currently open shift (`GET /sales/shifts/active`, which returns
 * `{ data: null }` rather than 404 when none is open) against the real
 * backend. Called right after login, and once on app start if a session
 * was persisted from a previous visit — so a role/permission change made
 * server-side while the till was closed is picked up immediately rather
 * than trusting the stale, persisted copy.
 */
export async function bootstrapSession(): Promise<void> {
  const [permissionsRes, shiftRes] = await Promise.all([permissionsApi.getMine(), shiftsApi.active()]);
  useAuthStore.getState().setPermissions(permissionsRes.data.permissions);
  useShiftStore.getState().setActiveShift(shiftRes.data);
}
