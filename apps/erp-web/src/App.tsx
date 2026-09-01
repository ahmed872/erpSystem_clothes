import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { SpinnerOverlay } from '@retail/ui-kit';
import { useAuthStore } from './store/authStore';
import { bootstrapSession } from './lib/bootstrap';
import { RequireAnyPermission, RequireAuth, RequirePermission } from './components/Guards';
import { AppShell } from './components/AppShell';
import { landingRoute } from './lib/navigation';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { CataloguePage } from './pages/CataloguePage';
import { ProductCreatePage } from './pages/ProductCreatePage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { PriceListsPage } from './pages/PriceListsPage';
import { SetupPage } from './pages/SetupPage';
import { InventoryPage } from './pages/InventoryPage';
import { TransfersPage } from './pages/TransfersPage';
import { TransferDetailPage } from './pages/TransferDetailPage';
import { StockCountPage } from './pages/StockCountPage';
import { SuppliersPage } from './pages/SuppliersPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { PurchaseCreatePage } from './pages/PurchaseCreatePage';
import { PurchaseDetailPage } from './pages/PurchaseDetailPage';
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
      {/* Phase 14. Each route is guarded on the SAME code its nav entry
          asks for, and the backend guards every call behind it again.
          Creating a product needs its own grant, so `/catalogue/new` is
          gated separately from the list — and is declared BEFORE
          `/catalogue/:productId` so it is not read as a product id. */}
      <Route element={<RequirePermission codes={['products.view']} fallback={fallback} />}>
        <Route path="/catalogue" element={<CataloguePage />} />
        <Route element={<RequirePermission codes={['products.create']} fallback="/catalogue" />}>
          <Route path="/catalogue/new" element={<ProductCreatePage />} />
        </Route>
        <Route path="/catalogue/:productId" element={<ProductDetailPage />} />
      </Route>
      {/* Phase 15. Every inventory READ is `inventory.view`; each mutation
          carries its own separate grant, checked on the control rather
          than the route, and by the backend regardless. `/transfers` is
          declared BEFORE `/counts/:id` siblings so no static segment is
          read as an id. */}
      <Route element={<RequirePermission codes={['inventory.view']} fallback={fallback} />}>
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/inventory/transfers" element={<TransfersPage />} />
        <Route path="/inventory/transfers/:transferId" element={<TransferDetailPage />} />
        <Route path="/inventory/counts/:countId" element={<StockCountPage />} />
      </Route>
      {/* Phase 16. Reading a purchase is `purchases.view`; raising one is
          its own grant, so `/purchases/new` is gated separately and
          declared BEFORE `/purchases/:purchaseId` so the static segment
          is never read as an id. Every lifecycle action beyond reading
          carries its own grant, checked on the control and again by the
          backend. */}
      <Route element={<RequirePermission codes={['purchases.view']} fallback={fallback} />}>
        <Route path="/purchases" element={<PurchasesPage />} />
        <Route element={<RequirePermission codes={['purchases.create']} fallback="/purchases" />}>
          <Route path="/purchases/new" element={<PurchaseCreatePage />} />
        </Route>
        <Route path="/purchases/:purchaseId" element={<PurchaseDetailPage />} />
      </Route>
      <Route element={<RequirePermission codes={['suppliers.view']} fallback={fallback} />}>
        <Route path="/suppliers" element={<SuppliersPage />} />
      </Route>
      <Route element={<RequirePermission codes={['pricelists.view']} fallback={fallback} />}>
        <Route path="/price-lists" element={<PriceListsPage />} />
      </Route>
      {/* Reference data fronts five separately-granted things, so the
          route admits anyone holding ANY of them and each TAB re-checks
          its own grant. */}
      <Route
        element={
          <RequireAnyPermission
            codes={['categories.view', 'brands.view', 'attributes.view', 'uoms.view', 'tax.view']}
            fallback={fallback}
          />
        }
      >
        <Route path="/setup" element={<SetupPage />} />
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
