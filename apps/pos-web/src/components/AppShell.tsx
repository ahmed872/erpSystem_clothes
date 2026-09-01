import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import { Button } from '@retail/ui-kit';
import { useAuthStore } from '../store/authStore';
import { useShiftStore } from '../store/shiftStore';
import { authApi } from '../api/auth';
import { setLanguage } from '../i18n';
import { usePermission } from '../hooks/usePermission';

export function AppShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clearAuth = useAuthStore((s) => s.clear);
  const activeShift = useShiftStore((s) => s.activeShift);
  const clearShift = useShiftStore((s) => s.setActiveShift);
  const canReturn = usePermission('sales.return');
  const canHold = usePermission('sales.hold');
  const canViewSales = usePermission('sales.view');
  const canViewWarranty = usePermission('warranty.view');
  const canViewShift = usePermission('shifts.view');
  const canCloseShift = usePermission('shifts.close');

  async function handleLogout() {
    try {
      if (refreshToken) await authApi.logout(refreshToken);
    } catch {
      /* logging out client-side regardless — the refresh token will simply expire server-side */
    }
    clearAuth();
    clearShift(null);
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex h-full min-h-screen flex-col bg-neutral-50">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <span className="shrink-0 text-base font-bold text-brand-700">{t('app.title')}</span>
          {/* Phase 12 (POS loose ends, B2) — THE NAVIGATION SURVIVES A
              NARROW TILL.
              This was `hidden sm:flex`, so below 640px every destination
              vanished: on a compact till or a phone the cashier could sell
              and nothing else - no returns, no held baskets, no shift, no
              way to close. There is no hamburger here on purpose; a till
              has a handful of destinations and hiding them behind a second
              tap is worse than letting them wrap. The row scrolls
              horizontally when it must, so the last item is always
              reachable rather than clipped. */}
          {activeShift && (
            <nav className="scrollbar-none -mx-1 flex min-w-0 items-center gap-1 overflow-x-auto px-1">
              <ShellNavLink to="/pos">{t('nav.pos')}</ShellNavLink>
              {canHold && <ShellNavLink to="/holds">{t('nav.holds')}</ShellNavLink>}
              {canViewSales && <ShellNavLink to="/lookup">{t('nav.lookup')}</ShellNavLink>}
              {canReturn && <ShellNavLink to="/returns">{t('nav.returns')}</ShellNavLink>}
              {canViewWarranty && <ShellNavLink to="/warranty">{t('nav.warranty')}</ShellNavLink>}
              {canViewShift && <ShellNavLink to="/shift">{t('nav.shift')}</ShellNavLink>}
              {canCloseShift && <ShellNavLink to="/shift-close">{t('nav.closeShift')}</ShellNavLink>}
            </nav>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={() => setLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
            className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100"
          >
            {t('nav.language')}
          </button>
          {user && <span className="hidden text-sm text-neutral-600 sm:inline">{user.name}</span>}
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            {t('nav.logout')}
          </Button>
        </div>
      </header>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}

function ShellNavLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-semibold transition-colors sm:px-3 ${
          isActive ? 'bg-brand-50 text-brand-700' : 'text-neutral-600 hover:bg-neutral-100'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
