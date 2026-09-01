import { permissionsApi } from '../api/permissions';
import { useAuthStore } from '../store/authStore';

/**
 * Phase 13 — re-validate the session against the REAL backend on every
 * load, exactly as the POS does.
 *
 * A persisted permission list is a cache, never evidence: a role changed
 * or revoked while the tab was closed must take effect on the next load,
 * and the only thing that can say what this account may do now is
 * `GET /permissions/me`.
 */
export async function bootstrapSession(): Promise<void> {
  const { data } = await permissionsApi.getMine();
  useAuthStore.getState().setPermissions(data.permissions);
}
