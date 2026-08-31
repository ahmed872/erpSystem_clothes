import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PermissionCode } from '../lib/apiTypes';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

interface AuthState {
  businessSlug: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  /** The caller's OWN effective permissions — from GET /permissions/me.
   * Used ONLY for navigation/UX visibility; every protected backend
   * endpoint keeps enforcing its own permission independently. */
  permissions: PermissionCode[];
  setSession: (session: { businessSlug: string; accessToken: string; refreshToken: string; user: AuthUser }) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  setPermissions: (permissions: PermissionCode[]) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      businessSlug: null,
      accessToken: null,
      refreshToken: null,
      user: null,
      permissions: [],
      setSession: ({ businessSlug, accessToken, refreshToken, user }) =>
        set({ businessSlug, accessToken, refreshToken, user }),
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setPermissions: (permissions) => set({ permissions }),
      clear: () => set({ businessSlug: null, accessToken: null, refreshToken: null, user: null, permissions: [] }),
    }),
    { name: 'ros-pos-auth' },
  ),
);

export function hasPermission(code: PermissionCode): boolean {
  return useAuthStore.getState().permissions.includes(code);
}
