import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, EmptyState, ErrorBanner, Input, Select, SpinnerOverlay } from '@retail/ui-kit';
import { salesApi } from '../api/sales';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { useShiftStore } from '../store/shiftStore';
import type { Sale, SalePaymentMethod } from '../lib/apiTypes';

interface ReturnLine {
  saleItemId: string;
  maxQuantity: number;
  label: string;
  selected: boolean;
  quantity: number;
  condition: 'SELLABLE' | 'DAMAGED';
}

export function ReturnsPage() {
  const { t } = useTranslation();
  const activeShift = useShiftStore((s) => s.activeShift);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);

  const salesQuery = useQuery({
    queryKey: ['shift-sales', activeShift?.id],
    queryFn: () => salesApi.listByShift(activeShift!.id),
    enabled: Boolean(activeShift),
  });

  if (!activeShift) return null;

  if (selectedSaleId) {
    return <ReturnForm saleId={selectedSaleId} onBack={() => setSelectedSaleId(null)} />;
  }

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <h1 className="mb-3 text-lg font-bold text-neutral-900">{t('returns.title')}</h1>
      <p className="mb-3 text-sm text-neutral-500">{t('returns.todaysSales')}</p>

      {salesQuery.isLoading && <SpinnerOverlay />}
      {salesQuery.isError && <ErrorBanner title={describeError(salesQuery.error).title} message={describeError(salesQuery.error).message} />}
      {salesQuery.data && salesQuery.data.data.length === 0 && <EmptyState title={t('returns.noSales')} />}

      <ul className="flex flex-col gap-2">
        {salesQuery.data?.data.map((sale) => (
          <li key={sale.id}>
            <button
              type="button"
              onClick={() => setSelectedSaleId(sale.id)}
              className="flex w-full items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 text-start hover:border-brand-400"
            >
              <div>
                <p className="text-sm font-semibold text-neutral-900">{sale.saleNumber}</p>
                <p className="text-xs text-neutral-500">{new Date(sale.createdAt).toLocaleString()}</p>
              </div>
              <span className="numeric text-sm font-bold text-brand-700">{formatMoney(sale.totalAmount)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReturnForm({ saleId, onBack }: { saleId: string; onBack: () => void }) {
  const saleQuery = useQuery({ queryKey: ['sale', saleId], queryFn: () => salesApi.get(saleId) });

  if (saleQuery.isLoading) return <SpinnerOverlay />;
  if (saleQuery.isError) {
    const { title, message } = describeError(saleQuery.error);
    return (
      <div className="p-4">
        <ErrorBanner title={title} message={message} />
      </div>
    );
  }
  return <ReturnFormBody sale={saleQuery.data!.data} onBack={onBack} />;
}

function ReturnFormBody({ sale, onBack }: { sale: Sale; onBack: () => void }) {
  const { t } = useTranslation();
  const isWalkIn = !sale.customerId;

  const [lines, setLines] = useState<ReturnLine[]>(
    sale.items.map((item) => ({
      saleItemId: item.id,
      maxQuantity: Number(item.quantity) - Number(item.quantityReturned),
      label: `${item.quantity} × ${formatMoney(item.unitPrice)}`,
      selected: false,
      quantity: Math.max(0, Number(item.quantity) - Number(item.quantityReturned)),
      condition: 'SELLABLE',
    })),
  );
  const [refundMethod, setRefundMethod] = useState<SalePaymentMethod>('CASH');
  const [refundAmount, setRefundAmount] = useState(0);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function updateLine(saleItemId: string, patch: Partial<ReturnLine>) {
    setLines((prev) => prev.map((l) => (l.saleItemId === saleItemId ? { ...l, ...patch } : l)));
  }

  const selectedLines = lines.filter((l) => l.selected && l.quantity > 0);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await salesApi.createReturn(sale.id, {
        reason: reason || undefined,
        refund: refundAmount > 0 ? { method: refundMethod, amount: refundAmount } : undefined,
        items: selectedLines.map((l) => ({ saleItemId: l.saleItemId, quantity: l.quantity, condition: l.condition })),
      });
      setResult(data.returnNumber);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <p className="text-lg font-bold text-success-700">✓ {result}</p>
        <Button className="mt-4" onClick={onBack}>
          {t('common.back')}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <button type="button" onClick={onBack} className="mb-3 text-sm text-brand-700">
        ← {t('common.back')}
      </button>
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{sale.saleNumber}</h1>
      {isWalkIn && <Badge tone="warning">{t('returns.refundMethod')} required — walk-in sale</Badge>}

      <div className="mt-3 flex flex-col gap-2">
        {lines.map((line, idx) => {
          const item = sale.items[idx];
          return (
            <Card key={line.saleItemId}>
              <CardBody className="flex flex-col gap-2 p-3">
                <label className="flex items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={line.selected}
                    disabled={line.maxQuantity <= 0}
                    onChange={(e) => updateLine(line.saleItemId, { selected: e.target.checked })}
                  />
                  {item.variantId} — {line.label}
                  {line.maxQuantity <= 0 && <Badge tone="neutral">fully returned</Badge>}
                </label>
                {line.selected && (
                  <div className="flex flex-wrap items-end gap-2">
                    <Input
                      label={t('pos.quantity')}
                      type="number"
                      className="numeric w-20"
                      min={1}
                      max={line.maxQuantity}
                      value={line.quantity}
                      onChange={(e) => updateLine(line.saleItemId, { quantity: Number(e.target.value) })}
                    />
                    <Select
                      label={t('returns.condition')}
                      value={line.condition}
                      onChange={(e) => updateLine(line.saleItemId, { condition: e.target.value as 'SELLABLE' | 'DAMAGED' })}
                    >
                      <option value="SELLABLE">{t('returns.sellable')}</option>
                      <option value="DAMAGED">{t('returns.damaged')}</option>
                    </Select>
                  </div>
                )}
              </CardBody>
            </Card>
          );
        })}
      </div>

      <Card className="mt-3">
        <CardBody className="flex flex-wrap items-end gap-2 p-3">
          <Select label={t('returns.refundMethod')} value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as SalePaymentMethod)}>
            <option value="CASH">{t('checkout.cash')}</option>
            <option value="CARD">{t('checkout.card')}</option>
            <option value="WALLET">{t('checkout.wallet')}</option>
            <option value="OTHER">{t('checkout.other')}</option>
          </Select>
          <Input
            label={t('returns.refundAmount')}
            type="number"
            className="numeric"
            min={0}
            step={0.01}
            value={refundAmount}
            onChange={(e) => setRefundAmount(Number(e.target.value))}
          />
          <Input label={t('common.search')} placeholder="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </CardBody>
      </Card>

      {error && (
        <div className="mt-3">
          <ErrorBanner title={error.title} message={error.message} />
        </div>
      )}

      <Button className="mt-3" size="lg" fullWidth disabled={selectedLines.length === 0 || submitting} loading={submitting} onClick={handleSubmit}>
        {t('returns.submit')}
      </Button>

      <p className="mt-3 text-xs text-neutral-400">{t('returns.exchangeNote')}</p>
    </div>
  );
}
