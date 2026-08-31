import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Shift } from '../lib/apiTypes';

interface ShiftState {
  activeShift: Shift | null;
  setActiveShift: (shift: Shift | null) => void;
}

/** Persisted so a page refresh mid-shift doesn't lose context — the
 * SOURCE OF TRUTH is always `GET /sales/shifts/active`, this is only a
 * cache the app re-validates against on load (see hooks/useAuthBootstrap.ts). */
export const useShiftStore = create<ShiftState>()(
  persist(
    (set) => ({
      activeShift: null,
      setActiveShift: (activeShift) => set({ activeShift }),
    }),
    { name: 'ros-pos-shift' },
  ),
);
