import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Select, Spinner } from '@retail/ui-kit';
import { purchasingApi } from '../api/purchasing';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDate, formatDateTime } from '../lib/datetime';
import {
  canApprovePurchase,
  canCancelPurchase,
  canPayPurchase,
  canReceivePurchase,
  canReturnPurchase,
  outstandingQuantity,
  purchaseTone,
  returnableQuantity,
} from '../lib/purchasing';
import { usePermission } from '../hooks/usePermission';
import type { PurchaseDetail, PurchaseItem, PurchasePaymentMethod } from '../lib/apiTypes';

/**
 * Phase 16 — ONE PURCHASE ORDER, AND THE SEPARATION OF DUTIES ON IT.
 *
 * The backend splits this document across five grants, and the live role
 * matrix puts them in three different pairs of hands:
 *
 *   purchases.create / .edit    INVENTORY_MANAGER raises the order
 *   purchases.approve           BRANCH_MANAGER commits the business to it
 *   purchases.receive / .return INVENTORY_MANAGER books the goods in
 *   purchases.pay               ACCOUNTANT settles it
 *
 * An INVENTORY_MANAGER holds create, edit, receive and return but NOT
 * approve, cancel or pay. So this screen renders one control per grant
 * and per state — never a single "process order" button, which would be
 * wrong even where the status allowed it.
 *
 * NOTHING HERE COMPUTES MONEY. Line totals and document totals are the
 * server's, stored on the document. Receiving posts the stock movement
 * AND the journal entry in the same transaction under the purchase-row
 * lock; this page sends what arrived and renders what came back.
 */
export function PurchaseDetailPage() {
  const { t } = useTranslation();
  const { purchaseId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const canApprove = usePermission('purchases.approve');
  const canCancel = usePermission('purchases.cancel');
  const canReceive = usePermission('purchases.receive');
  const canReturn = usePermission('purchases.return');
  const canPay = usePermission('purchases.pay');

  const [approving, setApproving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [returning, setReturning] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const detail = useQuery({ queryKey: ['purchase', purchaseId], queryFn: () => purchasingApi.getPurchase(purchaseId) });

  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['purchase', purchaseId] });
    await queryClient.invalidateQueries({ queryKey: ['purchases'] });
    await queryClient.invalidateQueries({ queryKey: ['balances'] });
    await queryClient.invalidateQueries({ queryKey: ['movements'] });
    await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
  }
  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }

  const [cancelReason, setCancelReason] = useState('');
  const approve = useMutation({
    mutationFn: () => purchasingApi.approvePurchase(purchaseId),
    onSuccess: async () => {
      setApproving(false);
      await refresh(t('purchases.approved'));
    },
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: () => purchasingApi.cancelPurchase(purchaseId, cancelReason.trim() || undefined),
    onSuccess: async () => {
      setCancelling(false);
      setCancelReason('');
      await refresh(t('purchases.cancelled'));
    },
    onError: fail,
  });

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

  const purchase = detail.data!.data;

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="numeric text-lg font-bold text-neutral-900" data-testid="purchase-number">
              {purchase.purchaseNumber}
            </h1>
            <Badge tone={purchaseTone(purchase.status)}>{t(`purchases.statusLabel.${purchase.status}`)}</Badge>
          </div>
          <p className="text-xs text-neutral-500">
            {purchase.supplier?.name ?? '—'} → {purchase.warehouse?.name ?? '—'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/purchases')}>
          {t('purchases.backToList')}
        </Button>
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="purchase-result">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}

      <Card className="mb-4">
        <CardBody className="grid grid-cols-1 gap-x-6 gap-y-1 p-4 sm:grid-cols-2">
          <Fact label={t('purchases.orderDate')} value={formatDate(purchase.orderDate)} />
          <Fact label={t('purchases.expectedDate')} value={purchase.expectedDate ? formatDate(purchase.expectedDate) : '—'} />
          {/* Every one of these is stored by the server. */}
          <Fact label={t('purchases.subtotal')} value={formatMoney(purchase.subtotal)} />
          <Fact label={t('purchases.tax')} value={formatMoney(purchase.taxAmount)} />
          <Fact label={t('purchases.discount')} value={formatMoney(purchase.discountAmount)} />
          <Fact label={t('purchases.total')} value={formatMoney(purchase.totalAmount)} testId="purchase-total" />
          {purchase.approvedAt && <Fact label={t('purchases.approvedAt')} value={formatDateTime(purchase.approvedAt)} />}
          {purchase.cancelledAt && <Fact label={t('purchases.cancelledAt')} value={formatDateTime(purchase.cancelledAt)} />}
          {purchase.cancelReason && <Fact label={t('purchases.cancelReason')} value={purchase.cancelReason} />}
          {purchase.notes && <Fact label={t('purchases.notes')} value={purchase.notes} />}
        </CardBody>
      </Card>

      <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('purchases.lines')}</h2>
      <DataTable
        data-testid="purchase-items"
        rows={purchase.items}
        rowKey={(i) => i.id}
        empty={t('purchases.noLines')}
        columns={[
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (i: PurchaseItem) => i.variant?.sku ?? i.variantId },
          { key: 'ordered', header: t('purchases.ordered'), align: 'end', className: 'numeric', cell: (i) => i.quantityOrdered },
          { key: 'received', header: t('purchases.received'), align: 'end', className: 'numeric', cell: (i) => i.quantityReceived },
          {
            key: 'outstanding',
            header: t('purchases.outstanding'),
            align: 'end',
            className: 'numeric',
            cell: (i) => {
              const left = outstandingQuantity(i);
              return left > 0 ? <span className="font-bold text-warning-700">{left}</span> : '—';
            },
          },
          { key: 'returned', header: t('purchases.returned'), align: 'end', className: 'numeric', cell: (i) => i.quantityReturned },
          { key: 'cost', header: t('purchases.unitCost'), align: 'end', className: 'numeric', cell: (i) => formatMoney(i.unitCost) },
          { key: 'line', header: t('purchases.lineTotal'), align: 'end', className: 'numeric', cell: (i) => formatMoney(i.lineTotal) },
        ]}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        {canApprove && canApprovePurchase(purchase) && (
          <Button onClick={() => setApproving(true)} data-testid="approve-purchase">
            {t('purchases.approve')}
          </Button>
        )}
        {canReceive && canReceivePurchase(purchase) && (
          <Button onClick={() => setReceiving(true)} data-testid="receive-purchase">
            {t('purchases.receive')}
          </Button>
        )}
        {canReturn && canReturnPurchase(purchase) && (
          <Button variant="secondary" onClick={() => setReturning(true)} data-testid="return-purchase">
            {t('purchases.return')}
          </Button>
        )}
        {canPay && canPayPurchase(purchase) && (
          <Button variant="secondary" onClick={() => setPaying(true)} data-testid="pay-purchase">
            {t('purchases.pay')}
          </Button>
        )}
        {canCancel && canCancelPurchase(purchase) && (
          <Button variant="danger" className="ms-auto" onClick={() => setCancelling(true)} data-testid="cancel-purchase">
            {t('purchases.cancel')}
          </Button>
        )}
      </div>

      <HistorySection purchase={purchase} />

      <ConfirmDialog
        open={approving}
        title={t('purchases.approve')}
        message={t('purchases.approveWarning')}
        confirmLabel={t('purchases.approve')}
        cancelLabel={t('common.cancel')}
        pending={approve.isPending}
        onConfirm={() => approve.mutate()}
        onClose={() => setApproving(false)}
        data-testid="approve-dialog"
      />

      <ConfirmDialog
        open={cancelling}
        tone="danger"
        title={t('purchases.cancel')}
        message={t('purchases.cancelWarning')}
        confirmLabel={t('purchases.cancel')}
        cancelLabel={t('common.cancel')}
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
        onClose={() => setCancelling(false)}
        data-testid="cancel-dialog"
      >
        <Input
          label={t('purchases.cancelReason')}
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          data-testid="cancel-reason"
        />
      </ConfirmDialog>

      {receiving && (
        <ReceiveDialog
          purchase={purchase}
          onClose={() => setReceiving(false)}
          onError={fail}
          onDone={async () => {
            setReceiving(false);
            await refresh(t('purchases.receivedOk'));
          }}
        />
      )}
      {returning && (
        <ReturnDialog
          purchase={purchase}
          onClose={() => setReturning(false)}
          onError={fail}
          onDone={async () => {
            setReturning(false);
            await refresh(t('purchases.returnedOk'));
          }}
        />
      )}
      {paying && (
        <PaymentDialog
          purchaseId={purchase.id}
          onClose={() => setPaying(false)}
          onError={fail}
          onDone={async () => {
            setPaying(false);
            await refresh(t('purchases.paidOk'));
          }}
        />
      )}
    </div>
  );
}

// ====================================================================
/**
 * Receiving. Serials go in as a free list per line; the browser splits
 * the string and validates nothing — whether a serial is required at
 * all, whether it already exists, and whether the count matches the
 * quantity are the server's, because only it knows the product's
 * tracking flag.
 *
 * THE IDEMPOTENCY KEY IS GENERATED ONCE PER DIALOG, not per click. That
 * is the whole point: a double-submitted delivery replays into the same
 * receipt instead of receiving the goods twice.
 */
function ReceiveDialog({
  purchase,
  onClose,
  onDone,
  onError,
}: {
  purchase: PurchaseDetail;
  onClose: () => void;
  onDone: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const receivable = purchase.items.filter((i) => outstandingQuantity(i) > 0);
  const [quantities, setQuantities] = useState<Record<string, string>>(
    Object.fromEntries(receivable.map((i) => [i.id, String(outstandingQuantity(i))])),
  );
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const receive = useMutation({
    mutationFn: () =>
      purchasingApi.receivePurchase(purchase.id, {
        idempotencyKey,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        items: receivable
          .filter((i) => Number(quantities[i.id] ?? 0) > 0)
          .map((i) => {
            const parsed = parseSerials(serials[i.id] ?? '');
            return {
              purchaseItemId: i.id,
              quantityReceived: Number(quantities[i.id]),
              ...(parsed.length > 0 ? { serials: parsed } : {}),
            };
          }),
      }),
    onSuccess: onDone,
    onError,
  });

  return (
    <ConfirmDialog
      open
      tone="danger"
      title={t('purchases.receive')}
      message={t('purchases.receiveWarning')}
      confirmLabel={t('purchases.receive')}
      cancelLabel={t('common.cancel')}
      pending={receive.isPending}
      onConfirm={() => receive.mutate()}
      onClose={onClose}
      data-testid="receive-dialog"
    >
      <p className="text-xs leading-snug text-neutral-500">{t('purchases.serialsHint')}</p>
      {receivable.map((item) => (
        <div key={item.id} className="flex flex-col gap-1">
          <Input
            label={t('purchases.receiveFor', {
              sku: item.variant?.sku ?? item.variantId,
              outstanding: outstandingQuantity(item),
            })}
            type="number"
            min="0"
            step="0.0001"
            value={quantities[item.id] ?? ''}
            onChange={(e) => setQuantities({ ...quantities, [item.id]: e.target.value })}
            data-testid={`receive-qty-${item.variant?.sku ?? item.variantId}`}
          />
          <Input
            label={t('purchases.serials')}
            value={serials[item.id] ?? ''}
            onChange={(e) => setSerials({ ...serials, [item.id]: e.target.value })}
            data-testid={`receive-serials-${item.variant?.sku ?? item.variantId}`}
          />
        </div>
      ))}
      <Input label={t('purchases.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
    </ConfirmDialog>
  );
}

function ReturnDialog({
  purchase,
  onClose,
  onDone,
  onError,
}: {
  purchase: PurchaseDetail;
  onClose: () => void;
  onDone: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const returnable = purchase.items.filter((i) => returnableQuantity(i) > 0);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');

  const send = useMutation({
    mutationFn: () =>
      purchasingApi.createPurchaseReturn(purchase.id, {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        items: returnable
          .filter((i) => Number(quantities[i.id] ?? 0) > 0)
          .map((i) => {
            const parsed = parseSerials(serials[i.id] ?? '');
            return {
              purchaseItemId: i.id,
              quantity: Number(quantities[i.id]),
              ...(parsed.length > 0 ? { serials: parsed } : {}),
            };
          }),
      }),
    onSuccess: onDone,
    onError,
  });

  return (
    <ConfirmDialog
      open
      tone="danger"
      title={t('purchases.return')}
      message={t('purchases.returnWarning')}
      confirmLabel={t('purchases.return')}
      cancelLabel={t('common.cancel')}
      pending={send.isPending}
      onConfirm={() => send.mutate()}
      onClose={onClose}
      data-testid="return-dialog"
    >
      {returnable.map((item) => (
        <div key={item.id} className="flex flex-col gap-1">
          <Input
            label={t('purchases.returnFor', {
              sku: item.variant?.sku ?? item.variantId,
              returnable: returnableQuantity(item),
            })}
            type="number"
            min="0"
            step="0.0001"
            value={quantities[item.id] ?? ''}
            onChange={(e) => setQuantities({ ...quantities, [item.id]: e.target.value })}
            data-testid={`return-qty-${item.variant?.sku ?? item.variantId}`}
          />
          <Input
            label={t('purchases.serials')}
            value={serials[item.id] ?? ''}
            onChange={(e) => setSerials({ ...serials, [item.id]: e.target.value })}
            data-testid={`return-serials-${item.variant?.sku ?? item.variantId}`}
          />
        </div>
      ))}
      <Input label={t('purchases.reason')} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="return-reason" />
    </ConfirmDialog>
  );
}

function PaymentDialog({
  purchaseId,
  onClose,
  onDone,
  onError,
}: {
  purchaseId: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PurchasePaymentMethod>('CASH');
  const [reference, setReference] = useState('');

  const pay = useMutation({
    mutationFn: () =>
      purchasingApi.createPurchasePayment(purchaseId, {
        amount: Number(amount),
        method,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      }),
    onSuccess: onDone,
    onError,
  });

  const METHODS: PurchasePaymentMethod[] = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER'];

  return (
    <ConfirmDialog
      open
      title={t('purchases.pay')}
      message={t('purchases.payWarning')}
      confirmLabel={t('purchases.pay')}
      cancelLabel={t('common.cancel')}
      pending={pay.isPending}
      onConfirm={() => pay.mutate()}
      onClose={onClose}
      data-testid="pay-dialog"
    >
      <Input
        label={t('purchases.amount')}
        type="number"
        min="0.0001"
        step="0.0001"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        data-testid="pay-amount"
      />
      <Select
        label={t('purchases.method')}
        value={method}
        onChange={(e) => setMethod(e.target.value as PurchasePaymentMethod)}
        data-testid="pay-method"
      >
        {METHODS.map((m) => (
          <option key={m} value={m}>
            {t(`purchases.methodLabel.${m}`)}
          </option>
        ))}
      </Select>
      <Input label={t('purchases.reference')} value={reference} onChange={(e) => setReference(e.target.value)} />
    </ConfirmDialog>
  );
}

// ====================================================================
function HistorySection({ purchase }: { purchase: PurchaseDetail }) {
  const { t } = useTranslation();
  return (
    <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div>
        <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('purchases.receipts')}</h2>
        <DataTable
          data-testid="purchase-receipts"
          rows={purchase.receipts}
          rowKey={(r) => r.id}
          empty={t('purchases.noReceipts')}
          columns={[
            { key: 'number', header: t('purchases.number'), className: 'numeric', cell: (r) => r.receiptNumber },
            { key: 'when', header: t('purchases.when'), cell: (r) => formatDateTime(r.receivedAt) },
          ]}
        />
      </div>
      <div>
        <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('purchases.returns')}</h2>
        <DataTable
          data-testid="purchase-returns"
          rows={purchase.returns}
          rowKey={(r) => r.id}
          empty={t('purchases.noReturns')}
          columns={[
            { key: 'number', header: t('purchases.number'), className: 'numeric', cell: (r) => r.returnNumber },
            { key: 'when', header: t('purchases.when'), cell: (r) => formatDateTime(r.createdAt) },
          ]}
        />
      </div>
      <div>
        <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('purchases.payments')}</h2>
        <DataTable
          data-testid="purchase-payments"
          rows={purchase.payments}
          rowKey={(p) => p.id}
          empty={t('purchases.noPayments')}
          columns={[
            { key: 'amount', header: t('purchases.amount'), align: 'end', className: 'numeric', cell: (p) => formatMoney(p.amount) },
            { key: 'method', header: t('purchases.method'), cell: (p) => t(`purchases.methodLabel.${p.method}`) },
            { key: 'when', header: t('purchases.when'), cell: (p) => formatDateTime(p.paidAt) },
          ]}
        />
      </div>
    </div>
  );
}

/** Splitting only. Every question about whether a serial is real, unique
 *  or required belongs to the server. */
function parseSerials(raw: string): string[] {
  return raw
    .split(/[\s,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function Fact({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-neutral-100 py-1 text-sm last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className="font-medium text-neutral-800" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
