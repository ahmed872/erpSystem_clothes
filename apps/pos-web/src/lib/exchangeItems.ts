import type { ProductVariant } from './apiTypes';

/**
 * Phase 12 (Exchange) — the cashier's working state for the REPLACEMENT
 * side of an exchange, and the only rules the browser is allowed to hold.
 *
 * Deliberately the same shape and the same mechanical rules as
 * `store/cartStore.ts`'s `CartLine` (merge-on-duplicate-add, serials
 * trimmed when quantity shrinks) and `lib/returnLines.ts`'s
 * `ReturnLineDraft` (a line is "ready" when its quantity and, for a
 * serial-tracked product, its serial count agree) — this is not a THIRD
 * design, it is the same one, applied to the other half of an exchange.
 *
 * WHAT IS NOT DECIDED HERE, ever: what the replacement costs, what the
 * exchange settles to, or which direction it is. Those come from
 * `POST /sales/:id/exchanges/preview` — the server's own answer, computed
 * by the same pipeline a sale quote uses. `unitPrice` here is only ever a
 * DEFAULT (the variant's shelf price) that the preview then prices
 * authoritatively; nothing in this file is trusted for money.
 */
export interface NewItemDraft {
  key: string;
  variantId: string;
  sku: string;
  variantLabel: string;
  tracksSerialNumbers: boolean;
  unitPrice: number;
  quantity: number;
  serials: string[];
}

function variantLabel(variant: ProductVariant): string {
  return variant.attributeValues.map((av) => av.attributeValue.value).join(' / ');
}

/** Adds a variant, merging into an existing line for the same variant
 * (matching `cartStore.addVariant`'s behaviour) rather than duplicating it. */
export function addNewItemDraft(drafts: NewItemDraft[], variant: ProductVariant, unitPrice: number): NewItemDraft[] {
  const existing = drafts.find((d) => d.variantId === variant.id);
  if (existing) {
    return drafts.map((d) => (d.key === existing.key ? { ...d, quantity: d.quantity + 1 } : d));
  }
  const draft: NewItemDraft = {
    key: variant.id,
    variantId: variant.id,
    sku: variant.sku,
    variantLabel: variantLabel(variant),
    tracksSerialNumbers: variant.product.tracksSerialNumbers,
    unitPrice,
    quantity: 1,
    serials: [],
  };
  return [draft, ...drafts];
}

export function updateNewItemQuantity(drafts: NewItemDraft[], key: string, quantity: number): NewItemDraft[] {
  if (quantity <= 0) return drafts.filter((d) => d.key !== key);
  return drafts.map((d) => (d.key === key ? { ...d, quantity, serials: d.serials.slice(0, quantity) } : d));
}

export function updateNewItemPrice(drafts: NewItemDraft[], key: string, unitPrice: number): NewItemDraft[] {
  return drafts.map((d) => (d.key === key ? { ...d, unitPrice: Math.max(0, unitPrice) } : d));
}

export function setNewItemSerials(drafts: NewItemDraft[], key: string, serials: string[]): NewItemDraft[] {
  return drafts.map((d) => (d.key === key ? { ...d, serials } : d));
}

export function removeNewItemDraft(drafts: NewItemDraft[], key: string): NewItemDraft[] {
  return drafts.filter((d) => d.key !== key);
}

/** A line is ready when it has a positive quantity and, for a
 * serial-tracked product, exactly that many UNIQUE serials captured. */
export function newItemIsReady(draft: NewItemDraft): boolean {
  if (draft.quantity <= 0) return false;
  if (!draft.tracksSerialNumbers) return true;
  const unique = new Set(draft.serials);
  return unique.size === draft.serials.length && draft.serials.length === draft.quantity;
}

/** Whether a preview/exchange may be requested at all: at least one
 * replacement line, and every one of them ready. */
export function canBuildExchange(returnReady: boolean, drafts: NewItemDraft[]): boolean {
  return returnReady && drafts.length > 0 && drafts.every(newItemIsReady);
}

/** The `newItems` shape both the preview and the exchange take. */
export function toNewItemsRequest(drafts: NewItemDraft[]) {
  return drafts.map((d) => ({
    variantId: d.variantId,
    quantity: d.quantity,
    unitPrice: d.unitPrice,
    ...(d.tracksSerialNumbers ? { serials: d.serials } : {}),
  }));
}
