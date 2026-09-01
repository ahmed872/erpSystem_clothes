import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Select, Spinner } from '@retail/ui-kit';
import { salesApi } from '../api/sales';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDateTime } from '../lib/datetime';
import {
  canRecordPayment,
  hasCost,
  hasProfit,
  isExchangeSale,
  isFullyReturned,
  isPartiallyReturned,
  paymentTone,
  saleTone,
} from '../lib/sales';
import { usePermission } from '../hooks/usePermission';
import type { SaleItemRow, SalePaymentMethod, SalePaymentRow, SaleReturnRow } from '../lib/apiTypes';

/**
 * Phase 17 — ONE SALE, INSPECTED.
 *
 * EVERY FIGURE IS FROZEN ON THE DOCUMENT. Totals, tax, per-line discount
 * and the price each unit sold at were computed by the pipeline that
 * wrote this sale and stored on it. Nothing here recomputes any of them,
 * which is why a sale from six months ago still reads correctly after the
 * tax rate, the price list and the promotion have all changed.
 *
 * THE PAYMENT SUMMARY IS THE SERVER'S. `paidAmount`, `remainingAmount`
 * and `paymentStatus` come from `computePaymentSummary` — this screen
 * does not subtract payments from a total, because a sale settled with an
 * exchange credit is PAID without its cash payments adding up.
 *
 * COST AND PROFIT ARE ADDED, NOT STRIPPED. `GetSaleUseCase` attaches
 * `totalCost`/`grossProfit` only for a holder of `products.view_cost`;
 * there is no cost column on the sale at all. So the tiles below appear
 * because the figures ARRIVED, never because a branch here allowed them.
 *
 * THE ONLY ACTION IS RECORDING A PAYMENT. Returns and exchanges are the
 * POS's workflow and are shown here as history, not performed.
 */
export function SaleDetailPage() {
  const { t } = useTranslation();
  const { saleId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canPay = usePermission('sales.pay');

  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const detail = useQuery({ queryKey: ['sale', saleId], queryFn: () => salesApi.get(saleId) });

  if (detail.isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="mx-auto max-w-4xl p-4">
        <ErrorBanner {...describeError(detail.error)} />
      </div>
    );
  }

  const sale = detail.data!.data;

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="numeric text-lg font-bold text-neutral-900" data-testid="sale-number">
              {sale.saleNumber}
            </h1>
            <Badge tone={saleTone(sale.status)}>{t(`sales.statusLabel.${sale.status}`)}</Badge>
            <Badge tone={paymentTone(sale.paymentStatus)} data-testid="payment-status">
              {t(`sales.paymentLabel.${sale.paymentStatus}`)}
            </Badge>
            {isExchangeSale(sale) && <Badge tone="brand">{t('sales.exchange')}</Badge>}
          </div>
          <p className="text-xs text-neutral-500">
            {formatDateTime(sale.createdAt)} · {sale.customer?.name ?? t('sales.walkIn')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate(`/sales/${sale.id}/receipt`)} data-testid="view-receipt">
            {t('sales.viewReceipt')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate('/sales')}>
            {t('sales.backToList')}
          </Button>
        </div>
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="sale-result">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={t('sales.subtotal')} value={formatMoney(sale.subtotal)} />
        <Tile label={t('sales.discount')} value={formatMoney(sale.discountAmount)} />
        <Tile label={t('sales.tax')} value={formatMoney(sale.taxAmount)} />
        <Tile label={t('sales.total')} value={formatMoney(sale.totalAmount)} testId="sale-total" />
        <Tile label={t('sales.paid')} value={formatMoney(sale.paidAmount)} testId="sale-paid" />
        <Tile label={t('sales.remaining')} value={formatMoney(sale.remainingAmount)} testId="sale-remaining" />
        {/* Rendered ONLY because the server sent them — i.e. only for a
            caller holding products.view_cost. */}
        {hasCost(sale) && <Tile label={t('sales.cost')} value={formatMoney(sale.totalCost)} testId="sale-cost" />}
        {hasProfit(sale) && <Tile label={t('sales.grossProfit')} value={formatMoney(sale.grossProfit)} testId="sale-profit" />}
      </div>

      <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('sales.lines')}</h2>
      <DataTable
        data-testid="sale-items"
        rows={sale.items}
        rowKey={(i) => i.id}
        empty={t('sales.noLines')}
        columns={[
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (i: SaleItemRow) => i.variant?.sku ?? i.variantId },
          { key: 'qty', header: t('sales.quantity'), align: 'end', className: 'numeric', cell: (i) => i.quantity },
          { key: 'price', header: t('sales.unitPrice'), align: 'end', className: 'numeric', cell: (i) => formatMoney(i.unitPrice) },
          {
            key: 'discount',
            header: t('sales.discount'),
            align: 'end',
            className: 'numeric',
            cell: (i) => formatMoney(i.discountAmount),
          },
          {
            key: 'tax',
            header: t('sales.tax'),
            align: 'end',
            className: 'numeric',
            // The rate SNAPSHOTTED on the line, not today's rate.
            cell: (i) => (
              <span>
                {formatMoney(i.taxAmount)}
                {i.taxRateSnapshot && <span className="ms-1 text-xs text-neutral-400">({i.taxRateSnapshot}%)</span>}
                {i.taxExempt && <span className="ms-1 text-xs text-neutral-400">{t('catalogue.taxExempt')}</span>}
              </span>
            ),
          },
          { key: 'line', header: t('sales.lineTotal'), align: 'end', className: 'numeric', cell: (i) => formatMoney(i.lineTotal) },
          {
            key: 'returned',
            header: t('sales.returned'),
            align: 'end',
            className: 'numeric',
            // Read from the line's own running total, which the return
            // pipeline maintains.
            cell: (i) =>
              isPartiallyReturned(i) ? (
                <span className={isFullyReturned(i) ? 'font-bold text-danger-700' : 'font-bold text-warning-700'}>
                  {i.quantityReturned}
                </span>
              ) : (
                '—'
              ),
          },
        ]}
      />

      {canPay && canRecordPayment(sale) && (
        <div className="mt-3">
          <Button onClick={() => setPaying(true)} data-testid="record-payment">
            {t('sales.recordPayment')}
          </Button>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('sales.payments')}</h2>
          <DataTable
            data-testid="sale-payments"
            rows={sale.payments}
            rowKey={(p) => p.id}
            empty={t('sales.noPayments')}
            columns={[
              {
                key: 'amount',
                header: t('sales.amount'),
                align: 'end',
                className: 'numeric',
                cell: (p: SalePaymentRow) => formatMoney(p.amount),
              },
              { key: 'method', header: t('sales.method'), cell: (p) => t(`sales.methodLabel.${p.method}`) },
              { key: 'ref', header: t('sales.reference'), cell: (p) => p.reference ?? '—' },
              { key: 'when', header: t('sales.when'), cell: (p) => formatDateTime(p.receivedAt) },
            ]}
          />
        </div>
        <div>
          <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('sales.returns')}</h2>
          {/* History, not an action: returns are performed at the till. */}
          <DataTable
            data-testid="sale-returns"
            rows={sale.returns}
            rowKey={(r) => r.id}
            empty={t('sales.noReturns')}
            columns={[
              { key: 'number', header: t('sales.returnNumber'), className: 'numeric', cell: (r: SaleReturnRow) => r.returnNumber },
              {
                key: 'refund',
                header: t('sales.refund'),
                align: 'end',
                className: 'numeric',
                // Null when the credit stayed on an account customer's
                // ledger rather than being handed back.
                cell: (r) => (r.refundAmount === null ? t('sales.onAccount') : formatMoney(r.refundAmount)),
              },
              { key: 'reason', header: t('sales.reason'), cell: (r) => r.reason ?? '—' },
              { key: 'when', header: t('sales.when'), cell: (r) => formatDateTime(r.createdAt) },
            ]}
          />
        </div>
      </div>

      {paying && (
        <PaymentDialog
          saleId={sale.id}
          remaining={sale.remainingAmount}
          onClose={() => setPaying(false)}
          onError={(e) => {
            setOk(null);
            setError(describeError(e));
          }}
          onDone={async () => {
            setPaying(false);
            setError(null);
            setOk(t('sales.paymentRecorded'));
            await queryClient.invalidateQueries({ queryKey: ['sale', saleId] });
            await queryClient.invalidateQueries({ queryKey: ['sales'] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Settling an invoice. The amount defaults to what the SERVER says is
 * still owed; the key is generated once per dialog so a double submit
 * records one payment rather than two.
 */
function PaymentDialog({
  saleId,
  remaining,
  onClose,
  onDone,
  onError,
}: {
  saleId: string;
  remaining: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(remaining);
  const [method, setMethod] = useState<SalePaymentMethod>('CASH');
  const [reference, setReference] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const pay = useMutation({
    mutationFn: () =>
      salesApi.pay(saleId, {
        amount: Number(amount),
        method,
        idempotencyKey,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      }),
    onSuccess: onDone,
    onError,
  });

  const METHODS: SalePaymentMethod[] = ['CASH', 'CARD', 'WALLET', 'OTHER'];

  return (
    <ConfirmDialog
      open
      title={t('sales.recordPayment')}
      message={t('sales.recordPaymentWarning')}
      confirmLabel={t('sales.recordPayment')}
      cancelLabel={t('common.cancel')}
      pending={pay.isPending}
      onConfirm={() => pay.mutate()}
      onClose={onClose}
      data-testid="payment-dialog"
    >
      <p className="text-xs text-neutral-500">
        {t('sales.remaining')}: <span className="numeric font-semibold">{formatMoney(remaining)}</span>
      </p>
      <Input
        label={t('sales.amount')}
        type="number"
        min="0.0001"
        step="0.0001"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        data-testid="payment-amount"
      />
      <Select
        label={t('sales.method')}
        value={method}
        onChange={(e) => setMethod(e.target.value as SalePaymentMethod)}
        data-testid="payment-method"
      >
        {METHODS.map((m) => (
          <option key={m} value={m}>
            {t(`sales.methodLabel.${m}`)}
          </option>
        ))}
      </Select>
      <Input label={t('sales.reference')} value={reference} onChange={(e) => setReference(e.target.value)} />
    </ConfirmDialog>
  );
}

function Tile({ label, value, testId }: { label: string; value: string | undefined; testId?: string }) {
  return (
    <Card>
      <CardBody className="p-3">
        <p className="text-xs text-neutral-500">{label}</p>
        <p className="numeric mt-1 text-base font-bold text-neutral-900" data-testid={testId}>
          {value ?? '—'}
        </p>
      </CardBody>
    </Card>
  );
}
