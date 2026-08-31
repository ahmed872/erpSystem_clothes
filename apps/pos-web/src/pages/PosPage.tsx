import { useState } from 'react';
import { useShiftStore } from '../store/shiftStore';
import { ProductSearchPanel } from './pos/ProductSearchPanel';
import { CartPanel } from './pos/CartPanel';
import { CheckoutModal } from './pos/CheckoutModal';

export function PosPage() {
  const activeShift = useShiftStore((s) => s.activeShift);
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  if (!activeShift) return null; // RequireShift already redirects; guards against a render race

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[1fr_360px] lg:grid-cols-[1fr_400px]">
      <ProductSearchPanel warehouseId={activeShift.warehouseId} />
      <CartPanel onCheckout={() => setCheckoutOpen(true)} />
      <CheckoutModal open={checkoutOpen} onClose={() => setCheckoutOpen(false)} />
    </div>
  );
}
