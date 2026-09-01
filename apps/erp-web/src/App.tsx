import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { SpinnerOverlay } from '@retail/ui-kit';
import { useAuthStore } from './store/authStore';
import { bootstrapSession } from './lib/bootstrap';
import { RequireAuth, RequirePermission } from './components/Guards';
import { AppShell } from './components/AppShell';
import { landingRoute } from './lib/navigation';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { WarrantyClaimsPage } from './pages/WarrantyClaimsPage';
import { ShiftsPage } from './pages/ShiftsPage';
import { NoAccessPage } from './pages/NoAccessPage';

/** On a fresh load with a persisted session, re-read the caller's effective
 *  permissions from the real backend before rendering anything that depends
 *  on them — a persisted copy is a cache, never evidence. */
function useSessionRestore() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [ready, setReady] = useState(!accessToken);

  useEffect(() => {
    if (!accessToken) {
      setReady(true);
      return;
    }
    let cancelled = false;
    bootstrapSession()
      .catch(() => {
        /* apiClient already clears the session on an unrecoverable 401 */
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ready;
}

function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/** Sends an authenticated user to the first module they can actually reach.
 *  Never a constant `/dashboard`: a caller without that grant would be
 *  redirected straight back out again. */
function LandingRedirect() {
  const permissions = useAuthStore((s) => s.permissions);
  const target = landingRoute(permissions);
  return <Navigate to={target ?? '/no-access'} replace />;
}

/** A route the caller lacks the grant for falls back to their own landing
 *  route rather than to a fixed path, so the fallback is never itself
 *  forbidden. */
function useFallback() {
  const permissions = useAuthStore((s) => s.permissions);
  return landingRoute(permissions) ?? '/no-access';
}

function GuardedRoutes() {
  const fallback = useFallback();
  const location = useLocation();
  // Keyed on pathname so a redirect target recomputed after a permission
  // refresh is applied on the next navigation rather than being cached.
  return (
    <Routes location={location}>
      <Route element={<RequirePermission codes={['reports.dashboard.view']} fallback={fallback} />}>
        <Route path="/dashboard" element={<DashboardPage />} />
      </Route>
      <Route element={<RequirePermission codes={['warranty.view']} fallback={fallback} />}>
        <Route path="/warranty-claims" element={<WarrantyClaimsPage />} />
      </Route>
      <Route element={<RequirePermission codes={['shifts.view']} fallback={fallback} />}>
        <Route path="/shifts" element={<ShiftsPage />} />
      </Route>
      <Route path="/no-access" element={<NoAccessPage />} />
      <Route path="/" element={<LandingRedirect />} />
      <Route path="*" element={<LandingRedirect />} />
    </Routes>
  );
}

export function App() {
  const ready = useSessionRestore();
  if (!ready) return <SpinnerOverlay />;

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<ShellLayout />}>
          <Route path="*" element={<GuardedRoutes />} />
        </Route>
      </Route>
    </Routes>
  );
}
