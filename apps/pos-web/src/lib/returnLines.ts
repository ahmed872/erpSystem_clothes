import type { SaleReceipt } from './apiTypes';

/**
 * Phase 12 (Returns) — the cashier's working state for a return, and the
 * only rules the browser is allowed to hold.
 *
 * WHAT IS DECIDED HERE. Purely mechanical facts about the form: how many
 * of a line remain returnable (a subtraction the receipt already gives the
 * parts for), whether the chosen serials match the chosen quantity, and
 * whether the request is complete enough to send. Nothing here computes
 * money.
 *
 * WHAT IS NOT DECIDED HERE, ever: what the return is worth. That is BD-1's
 * merchandise credit plus BD-18's cumulative tax reversal, and it comes
 * from `POST /sales/:id/returns/preview` - the same functions the real
 * return runs. The refund amount sent on the final request is the server's
 * own figure, never one this file derived.
 */
export interface ReturnLineDraft {
  saleItemId: string;
  sku: string;
  name: string;
  alternativeName: string | null;
  quantitySold: number;
  quantityAlreadyReturned: number;
  availableToReturn: number;
  soldSerials: string[];
  requiresSerials: boolean;
  selected: boolean;
  quantity: number;
  condition: 'SELLABLE' | 'DAMAGED';
  serials: string[];
}

/** Turns the receipt's own line record into the return form's state. */
export function draftFromReceipt(receipt: SaleReceipt): ReturnLineDraft[] {
  return receipt.items.map((item) => {
    const sold = Number(item.quantity);
    const returned = Number(item.quantityReturned);
    const available = Math.max(0, sold - returned);
    return {
      saleItemId: item.id,
      sku: item.sku,
      name: item.name,
      alternativeName: item.alternativeName,
      quantitySold: sold,
      quantityAlreadyReturned: returned,
      availableToReturn: available,
      soldSerials: item.serials,
      // The PRODUCT decides, and the sale's own record of the units it
      // delivered is the evidence: a line that left with serials is a line
      // that must name them coming back.
      requiresSerials: item.serials.length > 0,
      selected: false,
      quantity: available,
      condition: 'SELLABLE',
      serials: [],
    };
  });
}

/** The lines the cashier actually intends to return. */
export function selectedLines(lines: ReturnLineDraft[]): ReturnLineDraft[] {
  return lines.filter((l) => l.selected && l.quantity > 0);
}

/** A line is ready when its quantity is in range and, for a serial-tracked
 *  line, exactly that many units have been chosen. */
export function lineIsReady(line: ReturnLineDraft): boolean {
  if (line.quantity <= 0 || line.quantity > line.availableToReturn) return false;
  if (!line.requiresSerials) return true;
  const unique = new Set(line.serials);
  return unique.size === line.serials.length && line.serials.length === line.quantity;
}

/** Whether a preview may be requested at all. */
export function canPreview(lines: ReturnLineDraft[]): boolean {
  const chosen = selectedLines(lines);
  return chosen.length > 0 && chosen.every(lineIsReady);
}

/** The request body both the preview and the return take. */
export function toRequestItems(lines: ReturnLineDraft[]) {
  return selectedLines(lines).map((l) => ({
    saleItemId: l.saleItemId,
    quantity: l.quantity,
    condition: l.condition,
    ...(l.requiresSerials ? { serials: l.serials } : {}),
  }));
}
