import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ErrorBanner, Input, Select, SpinnerOverlay } from '@retail/ui-kit';
import { salesApi } from '../../api/sales';
import { describeError } from '../../lib/apiClient';
import { formatMoney, parseMoney } from '../../lib/money';
import { canPreview, draftFromReceipt, toRequestItems, type ReturnLineDraft } from '../../lib/returnLines';
import {
  addNewItemDraft,
  canBuildExchange,
  removeNewItemDraft,
  setNewItemSerials,
  toNewItemsRequest,
  updateNewItemPrice,
  updateNewItemQuantity,
  type NewItemDraft,
} from '../../lib/exchangeItems';
import { ReturnLineList } from '../returns/ReturnLineList';
import { ReturnSerialPicker } from '../returns/ReturnSerialPicker';
import { NewItemPicker } from './NewItemPicker';
import { SerialCaptureModal } from '../pos/SerialCaptureModal';
import { usePermission } from '../../hooks/usePermission';
import { loyaltyApi } from '../../api/loyalty';
import type { ExchangePreview, ExchangeResult, SalePaymentInput, SalePaymentMethod } from '../../lib/apiTypes';

/**
 * Phase 12 (Exchanges) — goods back, goods out, priced authoritatively
 * before any money moves.
 *
 * REUSES, NEVER REIMPLEMENTS. The return half is the SAME `ReturnLineList`
 * / `lib/returnLines.ts` machinery the stand-alone return uses; the
 * replacement half is `NewItemPicker`, the same search/scan/variant-pick
 * experience as the POS cart. Both feed `POST /sales/:id/exchanges/preview`
 * (`salesApi.previewExchange`), which is the ONLY place any of this is
 * priced — see `PreviewExchangeUseCase` on the server for what it composes
 * and why nothing here recomputes tax, promotions, loyalty, or the
 * settlement split.
 *
 * NO MONEY IS COMPUTED IN THIS FILE. `direction`, `amountDue` and
 * `refundAmount` are read from the preview and, at confirm, from the
 * commit's own response — never derived from `replacementTotal -
 * returnedValue` here, which is exactly the shortcut the preview exists to
 * avoid (a promotion, tax rate, or the credit's own tax component would
 * make that arithmetic wrong).
 */
export function ExchangeBuilder({ saleId, onBack, onDone }: { saleId: string; onBack: () => void; onDone: () => void }) {
  // Two reads of the same sale, exactly as the standalone builders do:
  // the RECEIPT for its line/serial detail (what `ReturnLineList` needs),
  // and the plain sale record for `warehouseId` - the replacement's stock
  // picker needs to know which warehouse's balances to show, and the
  // receipt payload does not carry it (only the branch does).
  const receiptQuery = useQuery({ queryKey: ['sale-receipt', saleId], queryFn: () => salesApi.receipt(saleId) });
  const saleQuery = useQuery({ queryKey: ['sale', saleId], queryFn: () => salesApi.get(saleId) });

  if (receiptQuery.isLoading || saleQuery.isLoading) return <SpinnerOverlay />;
  if (receiptQuery.isError || saleQuery.isError) {
    const { title, message } = describeError(receiptQuery.error ?? saleQuery.error);
    return (
      <div className="p-4">
        <ErrorBanner title={title} message={message} />
      </div>
    );
  }
  const receipt = receiptQuery.data!.data;
  return (
    <ExchangeForm
      saleId={saleId}
      saleNumber={receipt.sale.saleNumber}
      customerName={receipt.customer?.name ?? null}
      customerId={receipt.customer?.id ?? null}
      warehouseId={saleQuery.data!.data.warehouseId}
      returnLines={draftFromReceipt(receipt)}
      onBack={onBack}
      onDone={onDone}
    />
  );
}

function ExchangeForm({
  saleId,
  saleNumber,
  customerName,
  customerId,
  warehouseId,
  returnLines,
  onBack,
  onDone,
}: {
  saleId: string;
  saleNumber: string;
  customerName: string | null;
  /** The ORIGINAL SALE's customer. Loyalty belongs to them and is never
   *  switched to someone else here. */
  customerId: string | null;
  // The original sale's own warehouse, not a client choice — resolved
  // server-side from the sale, exactly as the real exchange resolves it
  // (see CreateExchangeUseCase). Used only for the replacement picker's
  // advisory stock badge; the commit re-resolves the warehouse itself and
  // never trusts anything this screen sends.
  warehouseId: string;
  returnLines: ReturnLineDraft[];
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canReturn = usePermission('sales.return');
  const canSell = usePermission('sales.create');
  const canViewLoyalty = usePermission('loyalty.view');

  const pointsQuery = useQuery({
    queryKey: ['loyalty-balance', customerId],
    queryFn: () => loyaltyApi.balance(customerId!),
    enabled: Boolean(customerId) && canViewLoyalty,
  });

  const [lines, setLines] = useState<ReturnLineDraft[]>(returnLines);
  const [newItems, setNewItems] = useState<NewItemDraft[]>([]);
  const [serialLineId, setSerialLineId] = useState<string | null>(null);
  const [newSerialKey, setNewSerialKey] = useState<string | null>(null);

  const [preview, setPreview] = useState<ExchangePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [payments, setPayments] = useState<SalePaymentInput[]>([]);
  const [refundMethod, setRefundMethod] = useState<SalePaymentMethod>('CASH');
  const [reason, setReason] = useState('');
  /**
   * Phase 12 (POS loose ends, U3) — POINTS ARE SPENDABLE ON AN EXCHANGE.
   *
   * `previewExchange` and `createExchange` have always accepted
   * `redeemPoints`, and the server applies it through the same BD-2/BD-3
   * pipeline a normal sale uses. The screen simply never offered the
   * control, so a customer swapping an item could not spend the points
   * they could have spent buying it outright — for no reason anyone chose.
   *
   * The value is an INPUT only. What the points are worth, whether the
   * balance covers them, and how they change the settlement are all the
   * preview's answers.
   */
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [result, setResult] = useState<ExchangeResult | null>(null);

  const updateReturnLine = useCallback((saleItemId: string, patch: Partial<ReturnLineDraft>) => {
    setPreview(null);
    setLines((prev) => prev.map((l) => (l.saleItemId === saleItemId ? { ...l, ...patch } : l)));
  }, []);

  const ready = canBuildExchange(canPreview(lines), newItems);

  async function handlePreview() {
    setPreviewing(true);
    setError(null);
    try {
      const { data } = await salesApi.previewExchange(saleId, {
        returnItems: toRequestItems(lines),
        newItems: toNewItemsRequest(newItems),
        redeemPoints: redeemPoints > 0 ? redeemPoints : undefined,
      });
      setPreview(data);
      const due = parseMoney(data.totals.amountDue);
      setPayments(due > 0 ? [{ method: 'CASH', amount: due }] : []);
    } catch (err) {
      setPreview(null);
      setError(describeError(err));
    } finally {
      setPreviewing(false);
    }
  }

  // Any edit to either half invalidates the preview - a stale outcome must
  // never be shown next to changed goods.
  useEffect(() => {
    setPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newItems, redeemPoints]);

  async function handleConfirm() {
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await salesApi.createExchange(saleId, {
        reason: reason || undefined,
        returnItems: toRequestItems(lines),
        newItems: toNewItemsRequest(newItems),
        // The SAME figure the preview was computed from: confirming with a
        // different redemption than the one priced would settle an
        // exchange the cashier never saw.
        redeemPoints: redeemPoints > 0 ? redeemPoints : undefined,
        payments: preview.direction === 'UPWARD' ? payments.filter((p) => p.amount > 0) : [],
        refund:
          preview.direction === 'DOWNWARD'
            ? { method: refundMethod, amount: parseMoney(preview.totals.refundAmount) }
            : undefined,
      });
      setResult(data);
    } catch (err) {
      // The commit re-resolved everything and disagreed - stock moved, a
      // promotion changed, a unit was returned elsewhere. Re-preview.
      setError(describeError(err));
      setPreview(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (!canReturn || !canSell) {
    return (
      <div className="p-4">
        <ErrorBanner title={t('errors.forbidden')} />
      </div>
    );
  }

  if (result) {
    return <ExchangeDone result={result} onAnother={onDone} onViewReceipt={() => navigate(`/receipt/${result.sale.id}`)} />;
  }

  const serialLine = lines.find((l) => l.saleItemId === serialLineId) ?? null;
  const newSerialItem = newItems.find((d) => d.key === newSerialKey) ?? null;

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <button type="button" onClick={onBack} className="mb-3 text-sm text-brand-700">
        ← {t('common.back')}
      </button>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="numeric text-lg font-bold text-neutral-900">{saleNumber}</h1>
        <Badge tone={customerName ? 'brand' : 'neutral'}>{customerName ?? t('returns.walkInSale')}</Badge>
        <Badge tone="warning">{t('exchange.title')}</Badge>
      </div>

      <p className="mb-2 text-sm font-semibold text-neutral-700">{t('exchange.returnSection')}</p>
      <ReturnLineList lines={lines} onUpdate={updateReturnLine} onChooseSerials={setSerialLineId} />

      <p className="mb-2 mt-4 text-sm font-semibold text-neutral-700">{t('exchange.newSection')}</p>
      <NewItemPicker
        warehouseId={warehouseId}
        onAdd={(variant, unitPrice) => setNewItems((prev) => addNewItemDraft(prev, variant, unitPrice))}
      />

      {newItems.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {newItems.map((item) => (
            <Card key={item.key}>
              <CardBody className="flex flex-col gap-2 p-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold text-neutral-900">{item.sku}</p>
                    {item.variantLabel && <p className="text-xs text-neutral-500">{item.variantLabel}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => setNewItems((prev) => removeNewItemDraft(prev, item.key))}
                    className="text-xs font-medium text-danger-600 hover:underline"
                  >
                    {t('pos.remove')}
                  </button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Input
                    label={t('pos.quantity')}
                    type="number"
                    className="numeric w-20"
                    min={1}
                    value={item.quantity}
                    onChange={(e) => setNewItems((prev) => updateNewItemQuantity(prev, item.key, Number(e.target.value)))}
                  />
                  <Input
                    label={t('pos.unitPrice')}
                    type="number"
                    className="numeric w-24"
                    min={0}
                    step={0.01}
                    value={item.unitPrice}
                    onChange={(e) => setNewItems((prev) => updateNewItemPrice(prev, item.key, Number(e.target.value)))}
                  />
                  {item.tracksSerialNumbers && (
                    <button
                      type="button"
                      onClick={() => setNewSerialKey(item.key)}
                      className={`mb-1 rounded-lg border px-3 py-2 text-xs font-medium ${
                        item.serials.length === item.quantity
                          ? 'border-success-600 text-success-700'
                          : 'border-warning-600 text-warning-700'
                      }`}
                    >
                      {item.serials.length === item.quantity
                        ? `${t('checkout.serialsTitle')}: ${item.serials.join(', ')}`
                        : `⚠ ${t('checkout.serialsRequired')}`}
                    </button>
                  )}
                </div>
              </CardBody>
            </Card>
          ))}
        </ul>
      )}

      {/* U3: offered only for an ACCOUNT sale, and only to a caller who
          may see loyalty at all - a walk-in has no balance to spend, and
          the points belong to the original sale's customer. */}
      {customerId && canViewLoyalty && pointsQuery.data && (
        <div className="mt-3 rounded-lg border border-neutral-200 p-3">
          <Input
            label={`${t('pos.redeemPoints')} (${t('pos.pointsAvailable')}: ${pointsQuery.data.data.balance})`}
            type="number"
            className="numeric w-32"
            min={0}
            max={parseMoney(pointsQuery.data.data.balance)}
            value={redeemPoints}
            onChange={(e) => setRedeemPoints(Math.max(0, Number(e.target.value)))}
            data-testid="exchange-redeem-points"
          />
          <p className="mt-1 text-[11px] leading-snug text-neutral-500">{t('exchange.redeemNotice')}</p>
        </div>
      )}

      <Button
        className="mt-3"
        variant="secondary"
        fullWidth
        disabled={!ready || previewing}
        loading={previewing}
        onClick={handlePreview}
        data-testid="preview-exchange"
      >
        {previewing ? t('exchange.previewing') : t('exchange.previewAction')}
      </Button>

      {preview && (
        <ExchangeOutcome
          preview={preview}
          payments={payments}
          setPayments={setPayments}
          refundMethod={refundMethod}
          setRefundMethod={setRefundMethod}
          reason={reason}
          setReason={setReason}
          submitting={submitting}
          onConfirm={handleConfirm}
        />
      )}

      {error && (
        <div className="mt-3">
          <ErrorBanner title={error.title} message={error.message} />
        </div>
      )}

      {serialLine && (
        <ReturnSerialPicker
          open={Boolean(serialLine)}
          productName={serialLine.name}
          soldSerials={serialLine.soldSerials}
          needed={serialLine.quantity}
          initial={serialLine.serials}
          onClose={() => setSerialLineId(null)}
          onSave={(serials) => {
            updateReturnLine(serialLine.saleItemId, { serials });
            setSerialLineId(null);
          }}
        />
      )}

      <SerialCaptureModal
        line={newSerialItem ? { productName: newSerialItem.sku, quantity: newSerialItem.quantity, serials: newSerialItem.serials } : null}
        onClose={() => setNewSerialKey(null)}
        onSave={(serials) => {
          if (newSerialItem) setNewItems((prev) => setNewItemSerials(prev, newSerialItem.key, serials));
          setNewSerialKey(null);
        }}
      />
    </div>
  );
}

function ExchangeOutcome({
  preview,
  payments,
  setPayments,
  refundMethod,
  setRefundMethod,
  reason,
  setReason,
  submitting,
  onConfirm,
}: {
  preview: ExchangePreview;
  payments: SalePaymentInput[];
  setPayments: (fn: (prev: SalePaymentInput[]) => SalePaymentInput[]) => void;
  refundMethod: SalePaymentMethod;
  setRefundMethod: (m: SalePaymentMethod) => void;
  reason: string;
  setReason: (r: string) => void;
  submitting: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const paidSum = payments.reduce((sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0), 0);
  const amountDue = parseMoney(preview.totals.amountDue);
  const remaining = Math.max(0, Math.round((amountDue - paidSum) * 10_000) / 10_000);
  const canConfirm =
    preview.direction === 'EVEN' ||
    (preview.direction === 'UPWARD' && Math.abs(remaining) < 0.00005) ||
    preview.direction === 'DOWNWARD';

  function updatePayment(index: number, patch: Partial<SalePaymentInput>) {
    setPayments((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }
  function addPayment() {
    setPayments((prev) => [...prev, { method: 'CASH', amount: Math.max(0, remaining) }]);
  }
  function removePayment(index: number) {
    setPayments((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <Card className="mt-3" data-testid="exchange-preview">
      <CardBody className="flex flex-col gap-3 p-3">
        <div className="rounded-lg bg-neutral-50 p-3">
          <div className="flex justify-between text-sm text-neutral-500">
            <span>{t('exchange.returnCredit')}</span>
            <span className="numeric" data-testid="exchange-return-credit">
              {formatMoney(preview.totals.returnCredit)}
            </span>
          </div>
          <div className="flex justify-between text-sm text-neutral-500">
            <span>{t('exchange.replacementTotal')}</span>
            <span className="numeric" data-testid="exchange-replacement-total">
              {formatMoney(preview.totals.replacementTotal)}
            </span>
          </div>
          <div className="flex justify-between text-sm text-neutral-500">
            <span>{t('exchange.creditApplied')}</span>
            <span className="numeric">{formatMoney(preview.totals.creditApplied)}</span>
          </div>

          {preview.direction === 'EVEN' && (
            <p className="mt-2 text-sm font-semibold text-success-700" data-testid="exchange-direction-even">
              {t('exchange.evenNotice')}
            </p>
          )}
          {preview.direction === 'UPWARD' && (
            <div className="mt-2 flex items-baseline justify-between border-t border-neutral-200 pt-2">
              <span className="text-sm font-bold text-neutral-900">{t('exchange.customerPays')}</span>
              <span className="numeric text-xl font-extrabold text-brand-700" data-testid="exchange-amount-due">
                {formatMoney(preview.totals.amountDue)}
              </span>
            </div>
          )}
          {preview.direction === 'DOWNWARD' && (
            <div className="mt-2 flex items-baseline justify-between border-t border-neutral-200 pt-2">
              <span className="text-sm font-bold text-neutral-900">{t('exchange.customerReceives')}</span>
              <span className="numeric text-xl font-extrabold text-success-700" data-testid="exchange-refund-amount">
                {formatMoney(preview.totals.refundAmount)}
              </span>
            </div>
          )}
        </div>

        {preview.direction === 'UPWARD' && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-neutral-700">{t('checkout.payments')}</p>
            {payments.map((p, i) => (
              <div key={i} className="flex items-end gap-2">
                <Select label={t('checkout.method')} value={p.method} onChange={(e) => updatePayment(i, { method: e.target.value as SalePaymentMethod })}>
                  <option value="CASH">{t('checkout.cash')}</option>
                  <option value="CARD">{t('checkout.card')}</option>
                  <option value="WALLET">{t('checkout.wallet')}</option>
                  <option value="OTHER">{t('checkout.other')}</option>
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
            <div className="flex justify-between text-sm">
              <span className="text-neutral-500">{t('checkout.remaining')}</span>
              <span className="numeric font-semibold">{formatMoney(remaining)}</span>
            </div>
          </div>
        )}

        {preview.direction === 'DOWNWARD' && (
          <Select label={t('returns.refundMethod')} value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as SalePaymentMethod)}>
            <option value="CASH">{t('checkout.cash')}</option>
            <option value="CARD">{t('checkout.card')}</option>
            <option value="WALLET">{t('checkout.wallet')}</option>
            <option value="OTHER">{t('checkout.other')}</option>
          </Select>
        )}

        <Input label={t('returns.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />

        <Button size="lg" fullWidth disabled={!canConfirm || submitting} loading={submitting} onClick={onConfirm} data-testid="confirm-exchange">
          {submitting ? t('exchange.confirming') : t('exchange.confirm')}
        </Button>
      </CardBody>
    </Card>
  );
}

function ExchangeDone({
  result,
  onAnother,
  onViewReceipt,
}: {
  result: ExchangeResult;
  onAnother: () => void;
  onViewReceipt: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md p-6 text-center">
      <p className="text-sm font-semibold text-success-700">✓ {t('exchange.doneTitle')}</p>
      <p className="numeric mt-1 text-xl font-bold text-neutral-900" data-testid="exchange-sale-number">
        {result.sale.saleNumber}
      </p>
      <div className="mt-3 flex flex-col gap-1 text-sm text-neutral-600">
        <p>
          {t('exchange.creditApplied')}: <span className="numeric font-bold">{formatMoney(result.exchangeCredit)}</span>
        </p>
        {parseMoney(result.amountDue) > 0 && (
          <p>
            {t('exchange.customerPays')}: <span className="numeric font-bold">{formatMoney(result.amountDue)}</span>
          </p>
        )}
        {parseMoney(result.refunded) > 0 && (
          <p>
            {t('exchange.customerReceives')}: <span className="numeric font-bold">{formatMoney(result.refunded)}</span>
          </p>
        )}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <Button onClick={onAnother}>{t('exchange.newExchange')}</Button>
        <Button variant="ghost" onClick={onViewReceipt}>
          {t('returns.viewReceipt')}
        </Button>
      </div>
    </div>
  );
}
