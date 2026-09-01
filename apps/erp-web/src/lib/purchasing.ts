import type { PurchaseDetail, PurchaseItem, PurchaseStatus, Supplier } from './apiTypes';

/**
 * Phase 16 — the only purchasing logic in the ERP browser, and it
 * computes no money.
 *
 * THERE IS NO TOTAL CALCULATOR HERE AND THERE MUST NEVER BE ONE, for the
 * same reason `lib/priceLists.ts` has no price resolver and
 * `lib/inventory.ts` has no balance arithmetic. `CreatePurchaseUseCase`
 * computes each `lineTotal` as `qty x unitCost + tax - discount`, sums
 * them into `subtotal`, and derives `totalAmount` — in Decimal, at the
 * database's precision, inside the transaction that writes the document.
 * A browser that added the same numbers up would be a second calculator
 * free to disagree with the one that actually persists.
 *
 * WHAT THAT COSTS, STATED PLAINLY: there is no authoritative pre-commit
 * preview endpoint for a purchase order — no `POST /purchases/quote` to
 * match the sale side's. So the create form shows the line inputs and
 * NOT a running total, and the authoritative figures appear on the
 * document the server returns. Reported as a known limitation rather
 * than papered over with browser arithmetic.
 */

/**
 * THE LIFECYCLE, mirrored from the live use-cases so the UI offers only
 * a transition the server would accept. Each is also a separate GRANT,
 * which is the real point: `purchases.create`, `.approve`, `.receive`
 * and `.pay` are held by different roles, so a single "process this
 * order" button would be wrong even if the states allowed it.
 *
 *   DRAFT              -> edit, approve, cancel
 *   APPROVED           -> receive, cancel
 *   PARTIALLY_RECEIVED -> receive, cancel
 *   RECEIVED           -> (terminal for receiving)
 *   CANCELLED          -> terminal
 */
const RECEIVABLE: PurchaseStatus[] = ['APPROVED', 'PARTIALLY_RECEIVED'];
const CANCELLABLE: PurchaseStatus[] = ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED'];

/** Only a DRAFT may be edited — `UpdatePurchaseUseCase` 409s otherwise. */
export function canEditPurchase(purchase: Pick<PurchaseDetail, 'status'>): boolean {
  return purchase.status === 'DRAFT';
}

/** Only a DRAFT may be approved, and only with at least one line. */
export function canApprovePurchase(purchase: Pick<PurchaseDetail, 'status' | 'items'>): boolean {
  return purchase.status === 'DRAFT' && purchase.items.length > 0;
}

export function canCancelPurchase(purchase: Pick<PurchaseDetail, 'status'>): boolean {
  return CANCELLABLE.includes(purchase.status);
}

export function canReceivePurchase(purchase: Pick<PurchaseDetail, 'status'>): boolean {
  return RECEIVABLE.includes(purchase.status);
}

/**
 * A return needs something actually received to send back. Read from the
 * document's own running totals, which the server maintains under its
 * purchase-row lock.
 */
export function canReturnPurchase(purchase: Pick<PurchaseDetail, 'status' | 'items'>): boolean {
  if (purchase.status === 'CANCELLED' || purchase.status === 'DRAFT') return false;
  return purchase.items.some((item) => returnableQuantity(item) > 0);
}

/** Payment is allowed against any order that was not cancelled. */
export function canPayPurchase(purchase: Pick<PurchaseDetail, 'status'>): boolean {
  return purchase.status !== 'CANCELLED' && purchase.status !== 'DRAFT';
}

export function purchaseTone(status: PurchaseStatus): 'neutral' | 'brand' | 'warning' | 'success' | 'danger' {
  switch (status) {
    case 'DRAFT':
      return 'neutral';
    case 'APPROVED':
      return 'brand';
    case 'PARTIALLY_RECEIVED':
      return 'warning';
    case 'RECEIVED':
      return 'success';
    default:
      return 'danger';
  }
}

/**
 * How much of a line is still to arrive, from the two figures the SERVER
 * maintains on it. Not a stock calculation: `quantityReceived` is the
 * document's own running total, incremented inside the receive
 * transaction while holding the purchase row lock, and the server
 * re-checks this itself before accepting anything — over-receiving is
 * rejected there, not here.
 */
export function outstandingQuantity(item: Pick<PurchaseItem, 'quantityOrdered' | 'quantityReceived'>): number {
  const ordered = Number(item.quantityOrdered);
  const received = Number(item.quantityReceived);
  if (!Number.isFinite(ordered) || !Number.isFinite(received)) return 0;
  return Math.max(0, ordered - received);
}

/** How much of a line could still go back to the supplier: what arrived,
 *  less what has already been returned. */
export function returnableQuantity(
  item: Pick<PurchaseItem, 'quantityReceived' | 'quantityReturned'>,
): number {
  const received = Number(item.quantityReceived);
  const returned = Number(item.quantityReturned);
  if (!Number.isFinite(received) || !Number.isFinite(returned)) return 0;
  return Math.max(0, received - returned);
}

/** Whether anything at all is still awaited on this order. */
export function isFullyReceived(purchase: Pick<PurchaseDetail, 'items'>): boolean {
  return purchase.items.every((item) => outstandingQuantity(item) === 0);
}

/**
 * A supplier may be deactivated only while active. The backend adds a
 * second refusal this cannot see — an open purchase blocks it — and
 * answers with a 409 the screen shows verbatim rather than trying to
 * predict.
 */
export function canDeactivateSupplier(supplier: Pick<Supplier, 'isActive'>): boolean {
  return supplier.isActive;
}

export function supplierTone(supplier: Pick<Supplier, 'isActive'>): 'success' | 'neutral' {
  return supplier.isActive ? 'success' : 'neutral';
}

/** Whether the caller was sent a payable balance for this supplier. */
export function hasBalance(supplier: Pick<Supplier, 'balance'>): boolean {
  return supplier.balance !== undefined;
}

/** A supplier we owe money to. Reads the SERVER's computed balance. */
export function isOwed(supplier: Pick<Supplier, 'balance'>): boolean {
  const n = Number(supplier.balance);
  return Number.isFinite(n) && n > 0;
}
