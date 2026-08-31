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
        <div className="flex items-center gap-6">
          <span className="text-base font-bold text-brand-700">{t('app.title')}</span>
          {activeShift && (
            <nav className="hidden items-center gap-1 sm:flex">
              <ShellNavLink to="/pos">{t('nav.pos')}</ShellNavLink>
              {canHold && <ShellNavLink to="/holds">{t('nav.holds')}</ShellNavLink>}
              {canReturn && <ShellNavLink to="/returns">{t('nav.returns')}</ShellNavLink>}
              {canViewShift && <ShellNavLink to="/shift">{t('nav.shift')}</ShellNavLink>}
              {canCloseShift && <ShellNavLink to="/shift-close">{t('nav.closeShift')}</ShellNavLink>}
            </nav>
          )}
        </div>
        <div className="flex items-center gap-2">
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
        `rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
          isActive ? 'bg-brand-50 text-brand-700' : 'text-neutral-600 hover:bg-neutral-100'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
