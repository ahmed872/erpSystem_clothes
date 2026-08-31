import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, ErrorBanner, Input, Modal, Select } from '@retail/ui-kit';
import { salesApi } from '../../api/sales';
import { describeError } from '../../lib/apiClient';
import { formatMoney } from '../../lib/money';
import { useCartStore } from '../../store/cartStore';
import { useShiftStore } from '../../store/shiftStore';
import type { SalePaymentInput, SalePaymentMethod } from '../../lib/apiTypes';

const METHODS: SalePaymentMethod[] = ['CASH', 'CARD', 'WALLET', 'OTHER'];

export function CheckoutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeShift = useShiftStore((s) => s.activeShift);
  const lines = useCartStore((s) => s.lines);
  const customer = useCartStore((s) => s.customer);
  const redeemPoints = useCartStore((s) => s.redeemPoints);
  const clearCart = useCartStore((s) => s.clear);

  const estimateSubtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const estimateDiscount = lines.reduce((sum, l) => sum + l.discountAmount, 0);
  const estimateTotal = Math.max(0, estimateSubtotal - estimateDiscount);

  const [payments, setPayments] = useState<SalePaymentInput[]>([{ method: 'CASH', amount: estimateTotal }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  // The modal is mounted once and toggled via `open`, so its own initial
  // `useState` only ever sees the cart total at FIRST MOUNT (typically 0,
  // before anything was added). Reset the default tender to the current
  // estimate every time the modal actually opens, or a walk-in's first
  // checkout attempt always tenders 0 and is rejected by the server's
  // exact-payment rule.
  useEffect(() => {
    if (open) {
      setPayments([{ method: 'CASH', amount: estimateTotal }]);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const paidSum = payments.reduce((sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0), 0);
  const remaining = Math.max(0, estimateTotal - paidSum);
  const isCreditSale = Boolean(customer);

  function updatePayment(index: number, patch: Partial<SalePaymentInput>) {
    setPayments((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function addPayment() {
    setPayments((prev) => [...prev, { method: 'CASH', amount: Math.max(0, remaining) }]);
  }

  function removePayment(index: number) {
    setPayments((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleConfirm() {
    if (!activeShift) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await salesApi.create({
        warehouseId: activeShift.warehouseId,
        customerId: customer?.id,
        items: lines.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountAmount: l.discountAmount,
          serials: l.tracksSerialNumbers ? l.serials : undefined,
        })),
        redeemPoints: redeemPoints > 0 ? redeemPoints : undefined,
        payments: payments.filter((p) => p.amount > 0),
      });
      clearCart();
      onClose();
      navigate(`/receipt/${data.id}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('checkout.title')} size="md">
      <div className="flex flex-col gap-4">
        <div className="rounded-lg bg-neutral-50 p-3">
          <div className="flex justify-between text-sm text-neutral-500">
            <span>{t('pos.subtotal')}</span>
            <span className="numeric">{formatMoney(estimateSubtotal)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold text-neutral-900">{t('pos.total')}</span>
            <span className="numeric text-xl font-extrabold text-brand-700">{formatMoney(estimateTotal)}</span>
          </div>
          <p className="mt-1 text-[11px] text-neutral-400">{t('pos.estimateNotice')}</p>
        </div>

        {isCreditSale && <p className="text-xs text-neutral-500">{t('checkout.creditSaleHint')}</p>}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-neutral-700">{t('checkout.payments')}</p>
          {payments.map((p, i) => (
            <div key={i} className="flex items-end gap-2">
              <Select label={t('checkout.method')} value={p.method} onChange={(e) => updatePayment(i, { method: e.target.value as SalePaymentMethod })}>
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
                step={0.01}
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

        <div className="flex justify-between text-sm">
          <span className="text-neutral-500">{t('checkout.remaining')}</span>
          <span className="numeric font-semibold">{formatMoney(remaining)}</span>
        </div>

        {error && <ErrorBanner title={error.title} message={error.message} />}

        <Button fullWidth size="lg" loading={submitting} disabled={submitting} onClick={handleConfirm}>
          {submitting ? t('checkout.confirming') : t('checkout.confirm')}
        </Button>
      </div>
    </Modal>
  );
}

