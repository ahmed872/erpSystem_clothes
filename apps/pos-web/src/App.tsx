import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { SpinnerOverlay } from '@retail/ui-kit';
import { useAuthStore } from './store/authStore';
import { bootstrapSession } from './lib/bootstrap';
import { RequireAuth, RequireShift } from './components/Guards';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { ShiftSetupPage } from './pages/ShiftSetupPage';
import { PosPage } from './pages/PosPage';
import { ReceiptPage } from './pages/ReceiptPage';
import { ReturnsPage } from './pages/ReturnsPage';
import { HeldSalesPage } from './pages/HeldSalesPage';
import { ShiftClosePage } from './pages/ShiftClosePage';

/** On a fresh page load with a persisted session, re-validate permissions
 * and the active shift against the real backend before rendering anything
 * that depends on them — a stale, persisted copy is never trusted. */
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

export function App() {
  const ready = useSessionRestore();

  if (!ready) return <SpinnerOverlay />;

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<ShellLayout />}>
          <Route path="/shift-setup" element={<ShiftSetupPage />} />

          <Route element={<RequireShift />}>
            <Route path="/pos" element={<PosPage />} />
            <Route path="/returns" element={<ReturnsPage />} />
            {/* Parked baskets get their own route and never appear in a
                sales list — a hold is not a sale. */}
            <Route path="/holds" element={<HeldSalesPage />} />
            <Route path="/shift-close" element={<ShiftClosePage />} />
            <Route path="/receipt/:saleId" element={<ReceiptPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/pos" replace />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
