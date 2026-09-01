import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import { Button } from '@retail/ui-kit';
import { useAuthStore } from '../store/authStore';
import { authApi } from '../api/auth';
import { setLanguage } from '../i18n';
import { visibleNav } from '../lib/navigation';

/**
 * Phase 13 (ERP foundation) — the back-office frame.
 *
 * Same shell language as the POS deliberately: one header, the same
 * language toggle, the same logout, the same logical-property layout that
 * mirrors under RTL without a second code path. ERP and POS are one
 * product and must not read as two.
 *
 * WHAT DIFFERS, AND WHY. The POS has a handful of destinations and one
 * role; the ERP has many and five. So the navigation is BUILT from
 * `GET /permissions/me` via `visibleNav` rather than written out with a
 * permission check per link — a list that grows with every later milestone
 * would otherwise become a place for a stale `&&` to hide. No role name
 * appears anywhere in this file.
 *
 * On a narrow screen the row scrolls rather than disappearing, which is the
 * lesson the POS learned in loose-ends B2: a manager on a tablet must still
 * reach every module.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clearAuth = useAuthStore((s) => s.clear);

  const items = visibleNav(permissions);

  async function handleLogout() {
    try {
      if (refreshToken) await authApi.logout(refreshToken);
    } catch {
      /* signing out client-side regardless — the refresh token expires server-side */
    }
    clearAuth();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex h-full min-h-screen flex-col bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <span className="shrink-0 text-base font-bold text-brand-700">{t('app.title')}</span>
          <nav className="scrollbar-none -mx-1 flex min-w-0 items-center gap-1 overflow-x-auto px-1" data-testid="erp-nav">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-semibold transition-colors sm:px-3 ${
                    isActive ? 'bg-brand-50 text-brand-700' : 'text-neutral-600 hover:bg-neutral-100'
                  }`
                }
              >
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={() => setLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
            className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100"
          >
            {t('nav.language')}
          </button>
          {user && (
            <span className="hidden text-sm text-neutral-600 sm:inline" data-testid="current-user">
              {user.name}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            {t('nav.logout')}
          </Button>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
