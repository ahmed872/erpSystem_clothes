import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, ErrorBanner, Input, Modal, Select, Spinner } from '@retail/ui-kit';
import { salesApi } from '../../api/sales';
import { holdsApi } from '../../api/holds';
import { describeError } from '../../lib/apiClient';
import { basketMatchesHold } from '../../lib/holdItems';
import { formatMoney, parseMoney } from '../../lib/money';
import { canConfirmTender, changeDue as computeChange, outstanding as computeOutstanding } from '../../lib/tender';
import { useCartStore } from '../../store/cartStore';
import { useShiftStore } from '../../store/shiftStore';
import type { SaleQuote, SalePaymentInput, SalePaymentMethod } from '../../lib/apiTypes';

const METHODS: SalePaymentMethod[] = ['CASH', 'CARD', 'WALLET', 'OTHER'];

/**
 * Phase 12 (Sale Quote) — checkout, now told the answer instead of
 * guessing it.
 *
 * WHAT CHANGED AND WHY. `POST /sales` requires the tender to equal the
 * sale total exactly, and that total only exists after the server has
 * resolved tax, promotions and loyalty from the tenant's own
 * configuration. This modal used to open with a client-side estimate -
 * quantity x price less manual discounts, with no tax and no promotion -
 * and any cart where those mattered was rejected on confirm. It now asks
 * `POST /sales/quote` the moment it opens and pays what the server says.
 *
 * NOTHING IS COMPUTED HERE THAT THE SERVER OWNS. The only arithmetic in
 * this file is `cashReceived - amountDue`, which is change: a physical
 * fact about the notes in the drawer, not a business rule. Tax,
 * promotions, loyalty and discounts arrive fully computed.
 *
 * THE QUOTE IS NOT A RESERVATION, and the failure path says so. If stock
 * ran out, a promotion started, or a price moved between the quote and the
 * confirm, the server refuses and the cashier re-quotes - which is one
 * button, and the honest outcome.
 *
 * PHASE 12 (HELD SALES) - RESUMING A PARKED BASKET COMES THROUGH HERE TOO,
 * and deliberately changes almost nothing. The quote is the SAME quote:
 * a hold stores inputs, so pricing a resumed basket is pricing a cart.
 * Only the confirm differs, and it has to. `POST /sales` would create the
 * sale and leave the basket sitting on the shelf OPEN for someone to sell
 * a second time; `POST /sales/holds/:id/resume` claims the hold and creates
 * the sale in ONE server transaction, which is what makes two cashiers
 * pressing confirm at once produce exactly one sale. There is still only
 * one sale-creation path behind both - `CreateSaleUseCase` - so a resumed
 * basket gets the same tax, promotions, loyalty, stock and serial checks,
 * resolved fresh at checkout rather than frozen when it was parked.
 */
export function CheckoutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeShift = useShiftStore((s) => s.activeShift);
  const lines = useCartStore((s) => s.lines);
  const customer = useCartStore((s) => s.customer);
  const redeemPoints = useCartStore((s) => s.redeemPoints);
  const resuming = useCartStore((s) => s.resuming);
  const clearCart = useCartStore((s) => s.clear);

  const [quote, setQuote] = useState<SaleQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [payments, setPayments] = useState<SalePaymentInput[]>([]);
  const [cashReceived, setCashReceived] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  const isCreditSale = Boolean(customer);

  /** The exact cart, in the shape both the quote and the sale accept. */
  const cartItems = useCallback(
    () =>
      lines.map((l) => ({
        variantId: l.variantId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountAmount: l.discountAmount,
        serials: l.tracksSerialNumbers ? l.serials : undefined,
      })),
    [lines],
  );

  const requestQuote = useCallback(async () => {
    if (!activeShift || lines.length === 0) return;
    setQuoting(true);
    setError(null);
    try {
      const { data } = await salesApi.quote({
        warehouseId: activeShift.warehouseId,
        customerId: customer?.id,
        items: cartItems(),
        redeemPoints: redeemPoints > 0 ? redeemPoints : undefined,
      });
      setQuote(data);
      const due = parseMoney(data.totals.amountDue);
      // Default to settling the whole thing in cash, which is what most
      // sales are. A cashier changing the method or splitting it edits
      // from here rather than typing the total again.
      setPayments([{ method: 'CASH', amount: due }]);
      setCashReceived(due);
    } catch (err) {
      setQuote(null);
      setError(describeError(err));
    } finally {
      setQuoting(false);
    }
  }, [activeShift, lines.length, customer?.id, redeemPoints, cartItems]);

  // Quote on every open. The cart may have changed since the last time,
  // and a stale quote is exactly what this feature exists to remove.
  useEffect(() => {
    if (open) {
      setQuote(null);
      setPayments([]);
      setError(null);
      void requestQuote();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The only arithmetic in this component, and all of it lives in
  // `lib/tender.ts` where it is unit-tested: how much is still owed, and
  // what change to hand back. Nothing here recomputes anything the server
  // is authoritative for.
  const amountDue = quote ? parseMoney(quote.totals.amountDue) : 0;
  const outstanding = computeOutstanding(amountDue, payments);
  const cashLine = payments.find((p) => p.method === 'CASH');
  const changeDue = cashLine ? computeChange(cashReceived, cashLine.amount) : 0;
  const overTendered = outstanding < -0.00005;
  const canConfirm =
    Boolean(quote) && !quoting && !submitting && canConfirmTender(amountDue, payments, isCreditSale);

  function updatePayment(index: number, patch: Partial<SalePaymentInput>) {
    setPayments((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function addPayment() {
    setPayments((prev) => [...prev, { method: 'CASH', amount: Math.max(0, outstanding) }]);
  }

  function removePayment(index: number) {
    setPayments((prev) => prev.filter((_, i) => i !== index));
  }

  /**
   * Confirming a PARKED basket, and the one subtlety worth knowing.
   *
   * `POST /sales/holds/:id/resume` sells the lines the SERVER has stored —
   * that is what lets it claim the hold and create the sale in a single
   * transaction. So anything the cashier changed after picking the basket
   * up (a serial finally scanned, a quantity corrected, a customer
   * attached) has to be written back with `PATCH /sales/holds/:id` first,
   * or it would be silently discarded and the wrong basket sold. The
   * comparison keeps that PATCH off the wire when nothing was touched,
   * which is the common case.
   *
   * If someone else resumes the basket between the patch and the resume,
   * the resume is refused with a conflict and no sale is created — which
   * is the correct outcome, and the same one two simultaneous confirms get.
   */
  async function confirmResume(heldSaleId: string, tender: SalePaymentInput[]): Promise<string> {
    const { data: stored } = await holdsApi.get(heldSaleId);
    const customerChanged = (stored.customerId ?? null) !== (customer?.id ?? null);
    if (customerChanged || !basketMatchesHold(stored, lines)) {
      await holdsApi.update(heldSaleId, { customerId: customer?.id ?? null, items: cartItems() });
    }
    const { data } = await holdsApi.resume(heldSaleId, {
      payments: tender,
      redeemPoints: redeemPoints > 0 ? redeemPoints : undefined,
    });
    return data.sale.id;
  }

  async function handleConfirm() {
    if (!activeShift || !quote) return;
    setSubmitting(true);
    setError(null);
    const tender = payments.filter((p) => p.amount > 0);
    try {
      const saleId = resuming
        ? await confirmResume(resuming.id, tender)
        : (
            await salesApi.create({
              warehouseId: activeShift.warehouseId,
              customerId: customer?.id,
              items: cartItems(),
              redeemPoints: redeemPoints > 0 ? redeemPoints : undefined,
              payments: tender,
            })
          ).data.id;
      clearCart();
      onClose();
      navigate(`/receipt/${saleId}`);
    } catch (err) {
      // The server re-resolved everything and disagreed - stock gone, a
      // promotion started, a price moved. Re-quoting is the recovery.
      //
      // ORDER MATTERS, and getting it wrong hid every failure:
      // `requestQuote` begins by clearing the error, so setting the banner
      // BEFORE re-quoting wiped it a moment later and the modal simply
      // reopened with no explanation of why the sale had not gone through.
      // The re-quote is awaited first, and the banner set last, so the
      // cashier is left looking at a fresh price AND the reason.
      const described = describeError(err);
      await requestQuote();
      setError(described);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={resuming ? t('holds.checkoutTitle') : t('checkout.title')} size="md">
      <div className="flex flex-col gap-4">
        {/* The basket became a sale at THIS moment, not when it was
            parked — and the totals above it were resolved just now. */}
        {resuming && (
          <div className="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2">
            <p className="numeric text-xs font-bold text-neutral-800" data-testid="checkout-hold-number">
              {resuming.holdNumber}
              {resuming.label ? ` · ${resuming.label}` : ''}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-neutral-600">{t('holds.checkoutNotice')}</p>
          </div>
        )}

        {quoting && !quote && (
          <div className="flex items-center justify-center gap-2 rounded-lg bg-neutral-50 p-6 text-sm text-neutral-500">
            <Spinner /> {t('checkout.quoting')}
          </div>
        )}

        {quote && (
          <div className="rounded-lg bg-neutral-50 p-3">
            <div className="flex justify-between text-sm text-neutral-500">
              <span>{t('pos.subtotal')}</span>
              <span className="numeric">{formatMoney(quote.totals.subtotal)}</span>
            </div>
            {parseMoney(quote.totals.discountAmount) > 0 && (
              <div className="flex justify-between text-sm text-neutral-500">
                <span>{t('pos.discount')}</span>
                <span className="numeric">-{formatMoney(quote.totals.discountAmount)}</span>
              </div>
            )}
            {parseMoney(quote.totals.taxAmount) > 0 && (
              <div className="flex justify-between text-sm text-neutral-500">
                <span>{t('pos.tax')}</span>
                <span className="numeric">{formatMoney(quote.totals.taxAmount)}</span>
              </div>
            )}
            <div className="mt-1 flex items-baseline justify-between border-t border-neutral-200 pt-1">
              <span className="text-sm font-semibold text-neutral-900">{t('checkout.amountDue')}</span>
              <span className="numeric text-2xl font-extrabold text-brand-700" data-testid="amount-due">
                {formatMoney(quote.totals.amountDue, quote.currency)}
              </span>
            </div>
            {/* Named promotions, because "why is this cheaper?" is asked at
                the counter and the answer is in the quote. */}
            {quote.lines.filter((l) => l.promotion).length > 0 && (
              <p className="mt-1 text-[11px] text-success-700">
                {quote.lines
                  .filter((l) => l.promotion)
                  .map((l) => l.promotion!.name)
                  .join(' · ')}
              </p>
            )}
            {parseMoney(quote.loyalty.redemptionValue) > 0 && (
              <p className="mt-1 text-[11px] text-neutral-500">
                {t('checkout.loyaltyApplied', { value: formatMoney(quote.loyalty.redemptionValue) })}
              </p>
            )}
            {quote.availability.some((a) => !a.sufficient) && (
              <p className="mt-1 text-[11px] text-warning-700">{t('checkout.stockWarning')}</p>
            )}
          </div>
        )}

        {isCreditSale && <p className="text-xs text-neutral-500">{t('checkout.creditSaleHint')}</p>}

        {quote && (
          <>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold text-neutral-700">{t('checkout.payments')}</p>
              {payments.map((p, i) => (
                <div key={i} className="flex items-end gap-2">
                  <Select
                    label={t('checkout.method')}
                    value={p.method}
                    onChange={(e) => updatePayment(i, { method: e.target.value as SalePaymentMethod })}
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t(`checkout.${m.toLowerCase()}`)}
                      </option>
                    ))}
                  </Select>
                  <Input
                    label={t('checkout.amount')}
                    type="number"
                    min={0}
                    step={0.0001}
                    className="numeric"
                    value={p.amount}
                    onChange={(e) => updatePayment(i, { amount: Number(e.target.value) })}
                  />
                  <Input
                    label={t('checkout.reference')}
                    value={p.reference ?? ''}
                    onChange={(e) => updatePayment(i, { reference: e.target.value || undefined })}
                  />
                  {payments.length > 1 && (
                    <button type="button" onClick={() => removePayment(i)} className="mb-2.5 text-danger-600" aria-label="remove">
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={addPayment}>
                + {t('checkout.addPayment')}
              </Button>
            </div>

            {/* CASH RECEIVED AND CHANGE. Deliberately separate from the
                tender amount: the server refuses overpayment and records
                only what the sale was worth, so the drawer takes
                `amountDue` and the change is handed back from the till.
                This figure is never sent anywhere. */}
            {cashLine && (
              <div className="rounded-lg border border-neutral-200 p-3">
                <Input
                  label={t('checkout.cashReceived')}
                  type="number"
                  min={0}
                  step={0.01}
                  className="numeric"
                  value={cashReceived}
                  onChange={(e) => setCashReceived(Number(e.target.value))}
                  data-testid="cash-received"
                />
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-neutral-700">{t('checkout.changeDue')}</span>
                  <span className="numeric text-lg font-bold text-neutral-900" data-testid="change-due">
                    {formatMoney(changeDue, quote.currency)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-neutral-400">{t('checkout.changeNotice')}</p>
              </div>
            )}

            <div className="flex justify-between text-sm">
              <span className="text-neutral-500">{t('checkout.remaining')}</span>
              <span className="numeric font-semibold" data-testid="outstanding">
                {formatMoney(Math.max(0, outstanding))}
              </span>
            </div>

            {overTendered && <p className="text-xs text-danger-600">{t('checkout.overTendered')}</p>}
          </>
        )}

        {error && <ErrorBanner title={error.title} message={error.message} />}

        {!quote && !quoting && (
          <Button fullWidth variant="secondary" onClick={() => void requestQuote()}>
            {t('checkout.retryQuote')}
          </Button>
        )}

        {quote && (
          <Button fullWidth size="lg" loading={submitting} disabled={!canConfirm} onClick={handleConfirm}>
            {submitting ? t('checkout.confirming') : t('checkout.confirm')}
          </Button>
        )}
      </div>
    </Modal>
  );
}
