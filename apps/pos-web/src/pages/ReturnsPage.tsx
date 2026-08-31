import { FormEvent, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, EmptyState, ErrorBanner, Input, Select, Spinner, SpinnerOverlay } from '@retail/ui-kit';
import { salesApi } from '../api/sales';
import { describeError } from '../lib/apiClient';
import { formatMoney, parseMoney } from '../lib/money';
import { canPreview, draftFromReceipt, toRequestItems, type ReturnLineDraft } from '../lib/returnLines';
import { useShiftStore } from '../store/shiftStore';
import { ReturnSerialPicker } from './returns/ReturnSerialPicker';
import type { SaleReceipt, SaleReturn, SaleReturnPreview, SalePaymentMethod } from '../lib/apiTypes';

/**
 * Phase 12 (Returns, finished properly).
 *
 * WHAT THIS REPLACES AND WHY. The previous screen could not complete two
 * whole categories of return. It sent no serials, so a serial-tracked
 * product was refused outright; it asked the cashier to type the refund
 * amount, which for a walk-in must equal the return credit EXACTLY - BD-1's
 * merchandise apportionment plus BD-18's cumulative tax reversal, a figure
 * nothing had ever shown them. It also labelled lines with raw variant
 * UUIDs and carried hard-coded English in an Arabic-first product.
 *
 * THE THREE FIXES, all on contracts that already existed:
 *
 *   1. Line data comes from `GET /sales/:id/receipt`, the sale's own record
 *      of what left the shop - product name, alternative name, SKU, how
 *      many are still returnable, and the exact serials delivered.
 *   2. Serial-tracked lines are CHOSEN from those delivered units.
 *   3. The refund comes from `POST /sales/:id/returns/preview`, computed by
 *      the same functions the return itself runs. For a walk-in the amount
 *      is the server's own figure and is not editable, because there is
 *      exactly one amount the server will accept.
 *
 * NO MONEY IS COMPUTED IN THIS FILE. Every figure displayed and every
 * figure sent comes from the preview.
 */
type Stage = { kind: 'find' } | { kind: 'build'; saleId: string } | { kind: 'done'; result: SaleReturn; saleId: string };

export function ReturnsPage() {
  const [stage, setStage] = useState<Stage>({ kind: 'find' });

  if (stage.kind === 'build') {
    return <ReturnBuilder saleId={stage.saleId} onBack={() => setStage({ kind: 'find' })} onDone={(result) => setStage({ kind: 'done', result, saleId: stage.saleId })} />;
  }
  if (stage.kind === 'done') {
    return <ReturnDone result={stage.result} saleId={stage.saleId} onAnother={() => setStage({ kind: 'find' })} />;
  }
  return <FindSale onPick={(saleId) => setStage({ kind: 'build', saleId })} />;
}

// ====================================================================
// 1 — FIND THE SALE
// ====================================================================
function FindSale({ onPick }: { onPick: (saleId: string) => void }) {
  const { t } = useTranslation();
  const activeShift = useShiftStore((s) => s.activeShift);
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  // The shift's own sales stay available as a shortcut - most returns are
  // for something sold minutes ago - but they are no longer the only way
  // in, which is what limited returns to the current shift.
  const recent = useQuery({
    queryKey: ['shift-sales', activeShift?.id],
    queryFn: () => salesApi.listByShift(activeShift!.id),
    enabled: Boolean(activeShift),
  });

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    const raw = term.trim();
    if (!raw) return;
    setSearching(true);
    setNotFound(false);
    setError(null);
    try {
      const { data } = await salesApi.findByNumber(raw);
      if (data.length === 0) setNotFound(true);
      else onPick(data[0].id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <h1 className="mb-3 text-lg font-bold text-neutral-900">{t('returns.title')}</h1>

      <Card>
        <CardBody className="p-3">
          <form onSubmit={handleSearch} className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-neutral-700">{t('returns.findSale')}</p>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label={t('returns.saleNumberLabel')}
                  hint={t('returns.saleNumberHint')}
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  className="numeric"
                  autoFocus
                  data-testid="sale-number-input"
                />
              </div>
              <Button type="submit" loading={searching} disabled={searching || term.trim().length === 0} data-testid="sale-number-search">
                {t('returns.searchAction')}
              </Button>
            </div>
          </form>
          {notFound && (
            <p className="mt-2 text-sm font-medium text-danger-600" data-testid="sale-not-found">
              {t('returns.notFound')}
            </p>
          )}
          {error && (
            <div className="mt-2">
              <ErrorBanner title={error.title} message={error.message} />
            </div>
          )}
        </CardBody>
      </Card>

      <p className="mb-2 mt-4 text-sm text-neutral-500">{t('returns.orPickRecent')}</p>
      {recent.isLoading && <Spinner />}
      {recent.data && recent.data.data.length === 0 && <EmptyState title={t('returns.noSales')} />}
      <ul className="flex flex-col gap-2">
        {recent.data?.data.map((sale) => (
          <li key={sale.id}>
            <button
              type="button"
              onClick={() => onPick(sale.id)}
              className="flex w-full items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 text-start hover:border-brand-400"
            >
              <div>
                <p className="numeric text-sm font-semibold text-neutral-900">{sale.saleNumber}</p>
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

// ====================================================================
// 2 — BUILD THE RETURN
// ====================================================================
function ReturnBuilder({ saleId, onBack, onDone }: { saleId: string; onBack: () => void; onDone: (r: SaleReturn) => void }) {
  const receiptQuery = useQuery({ queryKey: ['sale-receipt', saleId], queryFn: () => salesApi.receipt(saleId) });

  if (receiptQuery.isLoading) return <SpinnerOverlay />;
  if (receiptQuery.isError) {
    const { title, message } = describeError(receiptQuery.error);
    return (
      <div className="p-4">
        <ErrorBanner title={title} message={message} />
      </div>
    );
  }
  return <ReturnForm receipt={receiptQuery.data!.data} saleId={saleId} onBack={onBack} onDone={onDone} />;
}

function ReturnForm({
  receipt,
  saleId,
  onBack,
  onDone,
}: {
  receipt: SaleReceipt;
  saleId: string;
  onBack: () => void;
  onDone: (r: SaleReturn) => void;
}) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<ReturnLineDraft[]>(() => draftFromReceipt(receipt));
  const [serialLineId, setSerialLineId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SaleReturnPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [refundMethod, setRefundMethod] = useState<SalePaymentMethod>('CASH');
  const [refundAmount, setRefundAmount] = useState(0);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  const update = useCallback((saleItemId: string, patch: Partial<ReturnLineDraft>) => {
    // Any edit invalidates the figure the server gave for the previous
    // shape of the return. Clearing it is what stops a stale credit being
    // shown next to changed lines.
    setPreview(null);
    setLines((prev) => prev.map((l) => (l.saleItemId === saleItemId ? { ...l, ...patch } : l)));
  }, []);

  async function handlePreview() {
    setPreviewing(true);
    setError(null);
    try {
      const { data } = await salesApi.previewReturn(saleId, { items: toRequestItems(lines) });
      setPreview(data);
      // A walk-in gets the server's exact figure, locked. An account
      // customer is offered the whole credit and may take less.
      setRefundAmount(parseMoney(data.refund.requiredAmount ?? data.refund.maxAmount));
    } catch (err) {
      setPreview(null);
      setError(describeError(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleSubmit() {
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    try {
      // THE AMOUNT SENT IS THE SERVER'S OWN. For a walk-in it is
      // `requiredAmount` verbatim - never a number this screen derived.
      const amount = preview.refund.required ? parseMoney(preview.refund.requiredAmount!) : refundAmount;
      const { data } = await salesApi.createReturn(saleId, {
        reason: reason || undefined,
        refund: amount > 0 ? { method: refundMethod, amount } : undefined,
        items: toRequestItems(lines),
      });
      onDone(data);
    } catch (err) {
      // The return re-validated and disagreed - a unit already back, stock
      // moved, the sale changed. Re-previewing is the recovery.
      setError(describeError(err));
      setPreview(null);
    } finally {
      setSubmitting(false);
    }
  }

  const serialLine = lines.find((l) => l.saleItemId === serialLineId) ?? null;
  const ready = canPreview(lines);
  const overMax = preview ? refundAmount > parseMoney(preview.refund.maxAmount) + 0.00005 : false;

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <button type="button" onClick={onBack} className="mb-3 text-sm text-brand-700">
        ← {t('common.back')}
      </button>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="numeric text-lg font-bold text-neutral-900">{receipt.sale.saleNumber}</h1>
        <Badge tone={receipt.customer ? 'brand' : 'neutral'}>{receipt.customer ? receipt.customer.name : t('returns.walkInSale')}</Badge>
        <span className="text-xs text-neutral-500">
          {t('returns.soldOn')}: {new Date(receipt.sale.createdAt).toLocaleString()}
        </span>
      </div>

      <p className="mb-2 text-sm font-semibold text-neutral-700">{t('returns.selectItems')}</p>
      <div className="flex flex-col gap-2">
        {lines.map((line) => (
          <Card key={line.saleItemId}>
            <CardBody className="flex flex-col gap-2 p-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={line.selected}
                  disabled={line.availableToReturn <= 0}
                  onChange={(e) => update(line.saleItemId, { selected: e.target.checked })}
                  data-testid={`return-line-${line.sku}`}
                />
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-neutral-900">{line.name}</span>
                  {line.alternativeName && <span className="block text-xs text-neutral-500">{line.alternativeName}</span>}
                  <span className="numeric block text-xs text-neutral-500">{line.sku}</span>
                  <span className="mt-1 flex flex-wrap gap-2 text-[11px] text-neutral-500">
                    <span>
                      {t('returns.soldQuantity')}: <span className="numeric">{line.quantitySold}</span>
                    </span>
                    {line.quantityAlreadyReturned > 0 && (
                      <span>
                        {t('returns.alreadyReturned')}: <span className="numeric">{line.quantityAlreadyReturned}</span>
                      </span>
                    )}
                    <span>
                      {t('returns.availableToReturn')}: <span className="numeric">{line.availableToReturn}</span>
                    </span>
                  </span>
                </span>
                {line.availableToReturn <= 0 && <Badge tone="neutral">{t('returns.fullyReturned')}</Badge>}
              </label>

              {line.selected && (
                <div className="flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-2">
                  <Input
                    label={t('returns.quantityToReturn')}
                    type="number"
                    className="numeric w-24"
                    min={1}
                    max={line.availableToReturn}
                    value={line.quantity}
                    onChange={(e) => update(line.saleItemId, { quantity: Number(e.target.value), serials: [] })}
                  />
                  <Select
                    label={t('returns.condition')}
                    value={line.condition}
                    onChange={(e) => update(line.saleItemId, { condition: e.target.value as 'SELLABLE' | 'DAMAGED' })}
                  >
                    <option value="SELLABLE">{t('returns.sellable')}</option>
                    <option value="DAMAGED">{t('returns.damaged')}</option>
                  </Select>
                  {line.requiresSerials && (
                    <button
                      type="button"
                      onClick={() => setSerialLineId(line.saleItemId)}
                      className={`mb-1 rounded-lg border px-3 py-2 text-xs font-medium ${
                        line.serials.length === line.quantity
                          ? 'border-success-600 text-success-700'
                          : 'border-warning-600 text-warning-700'
                      }`}
                      data-testid={`choose-serials-${line.sku}`}
                    >
                      {line.serials.length === line.quantity
                        ? `${t('returns.chooseSerials')}: ${line.serials.join(', ')}`
                        : t('returns.serialsNeeded', { needed: line.quantity })}
                    </button>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        ))}
      </div>

      <Button
        className="mt-3"
        variant="secondary"
        fullWidth
        disabled={!ready || previewing}
        loading={previewing}
        onClick={handlePreview}
        data-testid="preview-return"
      >
        {previewing ? t('returns.previewing') : t('returns.previewAction')}
      </Button>

      {preview && (
        <Card className="mt-3">
          <CardBody className="flex flex-col gap-2 p-3">
            <div className="rounded-lg bg-neutral-50 p-3">
              <div className="flex justify-between text-sm text-neutral-500">
                <span>{t('returns.merchandiseCredit')}</span>
                <span className="numeric">{formatMoney(preview.totals.merchandiseCredit)}</span>
              </div>
              {parseMoney(preview.totals.taxReversal) > 0 && (
                <div className="flex justify-between text-sm text-neutral-500">
                  <span>{t('returns.taxReversal')}</span>
                  <span className="numeric">{formatMoney(preview.totals.taxReversal)}</span>
                </div>
              )}
              <div className="mt-1 flex items-baseline justify-between border-t border-neutral-200 pt-1">
                <span className="text-sm font-semibold text-neutral-900">{t('returns.totalRefundable')}</span>
                <span className="numeric text-2xl font-extrabold text-brand-700" data-testid="total-refundable">
                  {formatMoney(preview.totals.totalRefundable)}
                </span>
              </div>
            </div>

            <p className="text-xs text-neutral-500">
              {preview.refund.required ? t('returns.refundExactNotice') : t('returns.refundLedgerNotice')}
            </p>

            <div className="flex flex-wrap items-end gap-2">
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
                step={0.0001}
                /* A walk-in has exactly one acceptable amount, so the field
                   is the server's figure and is not editable. */
                readOnly={preview.refund.required}
                value={preview.refund.required ? parseMoney(preview.refund.requiredAmount!) : refundAmount}
                onChange={(e) => setRefundAmount(Number(e.target.value))}
                data-testid="refund-amount"
              />
              {!preview.refund.required && (
                <div className="mb-2 text-xs text-neutral-500">
                  {t('returns.toLedger')}:{' '}
                  <span className="numeric font-semibold">
                    {formatMoney(Math.max(0, parseMoney(preview.totals.totalRefundable) - refundAmount))}
                  </span>
                </div>
              )}
            </div>

            <Input label={t('returns.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />

            {overMax && (
              <p className="text-xs text-danger-600">{t('returns.refundOverMax', { max: formatMoney(preview.refund.maxAmount) })}</p>
            )}

            <Button size="lg" fullWidth disabled={submitting || overMax} loading={submitting} onClick={handleSubmit} data-testid="confirm-return">
              {submitting ? t('returns.submitting') : t('returns.submit')}
            </Button>
          </CardBody>
        </Card>
      )}

      {error && (
        <div className="mt-3">
          <ErrorBanner title={error.title} message={error.message} />
        </div>
      )}

      <p className="mt-3 text-xs text-neutral-400">{t('returns.exchangeNote')}</p>

      {serialLine && (
        <ReturnSerialPicker
          open={Boolean(serialLine)}
          productName={serialLine.name}
          soldSerials={serialLine.soldSerials}
          needed={serialLine.quantity}
          initial={serialLine.serials}
          onClose={() => setSerialLineId(null)}
          onSave={(serials) => {
            update(serialLine.saleItemId, { serials });
            setSerialLineId(null);
          }}
        />
      )}
    </div>
  );
}

// ====================================================================
// 3 — DONE
// ====================================================================
function ReturnDone({ result, saleId, onAnother }: { result: SaleReturn; saleId: string; onAnother: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-md p-6 text-center">
      <p className="text-sm font-semibold text-success-700">✓ {t('returns.doneTitle')}</p>
      <p className="numeric mt-1 text-xl font-bold text-neutral-900" data-testid="return-number">
        {result.returnNumber}
      </p>
      {result.refundAmount && (
        <p className="mt-2 text-sm text-neutral-600">
          {t('returns.refunded')}: <span className="numeric font-bold">{formatMoney(result.refundAmount)}</span>
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2">
        <Button onClick={onAnother}>{t('returns.newReturn')}</Button>
        <Button variant="ghost" onClick={() => navigate(`/receipt/${saleId}`)}>
          {t('returns.viewReceipt')}
        </Button>
      </div>
    </div>
  );
}
