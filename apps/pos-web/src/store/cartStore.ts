import { create } from 'zustand';
import type { Customer, ProductVariant } from '../lib/apiTypes';

export interface CartLine {
  /** Local, cart-scoped id — lets the same variant appear as two lines
   * (e.g. two different discounts) if ever needed; today one line per
   * variant is enforced by `addVariant`. */
  key: string;
  variantId: string;
  sku: string;
  productName: string;
  variantLabel: string;
  tracksSerialNumbers: boolean;
  unitPrice: number;
  quantity: number;
  discountAmount: number;
  serials: string[];
}

interface CartState {
  lines: CartLine[];
  customer: Customer | null;
  redeemPoints: number;
  addVariant: (variant: ProductVariant, unitPrice: number) => void;
  updateQuantity: (key: string, quantity: number) => void;
  updateDiscount: (key: string, discountAmount: number) => void;
  updateUnitPrice: (key: string, unitPrice: number) => void;
  setSerials: (key: string, serials: string[]) => void;
  removeLine: (key: string) => void;
  setCustomer: (customer: Customer | null) => void;
  setRedeemPoints: (points: number) => void;
  clear: () => void;
}

function variantLabel(variant: ProductVariant): string {
  return variant.attributeValues.map((av) => av.attributeValue.value).join(' / ');
}

export const useCartStore = create<CartState>()((set) => ({
  lines: [],
  customer: null,
  redeemPoints: 0,
  addVariant: (variant, unitPrice) =>
    set((state) => {
      const existing = state.lines.find((l) => l.variantId === variant.id);
      if (existing) {
        return {
          lines: state.lines.map((l) => (l.key === existing.key ? { ...l, quantity: l.quantity + 1 } : l)),
        };
      }
      const line: CartLine = {
        key: variant.id,
        variantId: variant.id,
        sku: variant.sku,
        productName: variant.product.name,
        variantLabel: variantLabel(variant),
        tracksSerialNumbers: variant.product.tracksSerialNumbers,
        unitPrice,
        quantity: 1,
        discountAmount: 0,
        serials: [],
      };
      return { lines: [line, ...state.lines] };
    }),
  updateQuantity: (key, quantity) =>
    set((state) => ({
      lines:
        quantity <= 0
          ? state.lines.filter((l) => l.key !== key)
          : state.lines.map((l) => (l.key === key ? { ...l, quantity, serials: l.serials.slice(0, quantity) } : l)),
    })),
  updateDiscount: (key, discountAmount) =>
    set((state) => ({ lines: state.lines.map((l) => (l.key === key ? { ...l, discountAmount: Math.max(0, discountAmount) } : l)) })),
  updateUnitPrice: (key, unitPrice) =>
    set((state) => ({ lines: state.lines.map((l) => (l.key === key ? { ...l, unitPrice: Math.max(0, unitPrice) } : l)) })),
  setSerials: (key, serials) => set((state) => ({ lines: state.lines.map((l) => (l.key === key ? { ...l, serials } : l)) })),
  removeLine: (key) => set((state) => ({ lines: state.lines.filter((l) => l.key !== key) })),
  setCustomer: (customer) => set({ customer, redeemPoints: customer ? 0 : 0 }),
  setRedeemPoints: (redeemPoints) => set({ redeemPoints: Math.max(0, redeemPoints) }),
  clear: () => set({ lines: [], customer: null, redeemPoints: 0 }),
}));
