import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Spinner } from '@retail/ui-kit';
import { inventoryApi } from '../api/inventory';
import { describeError } from '../lib/apiClient';
import { formatDateTime } from '../lib/datetime';
import { canReceiveTransfer, canSendTransfer, outstandingQuantity, transferTone } from '../lib/inventory';
import { usePermission } from '../hooks/usePermission';
import type { StockTransfer, TransferItem } from '../lib/apiTypes';

/**
 * Phase 15 — one transfer, and the two acts that move real stock.
 *
 * SENDING is where availability is finally checked and the source is
 * decremented, under the engine's `SELECT ... FOR UPDATE`. A
 * serial-tracked line must name one serial per unit or the send is
 * refused — the browser collects those strings and validates none of
 * them; the server owns whether a serial exists, is in that warehouse,
 * and is not already sold.
 *
 * RECEIVING books in what was actually in the box, in ONE call covering
 * every line — the backend has no staged receiving. The transfer then
 * completes whether or not everything arrived, and a quantity below what
 * was sent is reported as a discrepancy rather than silently corrected:
 * the destination is credited only with what actually turned up. A
 * serial-tracked unit that was shipped but not listed keeps IN_TRANSIT
 * status rather than being placed in either warehouse.
 *
 * So this screen defaults each line to everything that was sent, shows
 * the shortfall when there is one, and decides nothing about it.
 */
export function TransferDetailPage() {
  const { t } = useTranslation();
  const { transferId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canSend = usePermission('inventory.transfer_send');
  const canReceive = usePermission('inventory.transfer_receive');

  const [sending, setSending] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [received, setReceived] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['transfer', transferId],
    queryFn: () => inventoryApi.getTransfer(transferId),
  });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['transfer', transferId] });
    await queryClient.invalidateQueries({ queryKey: ['transfers'] });
    await queryClient.invalidateQueries({ queryKey: ['balances'] });
    await queryClient.invalidateQueries({ queryKey: ['movements'] });
    await queryClient.invalidateQueries({ queryKey: ['serials'] });
  }

  const send = useMutation({
    mutationFn: () => {
      // One entry per line that had serials typed. A line with none is
      // omitted entirely, which is exactly what the schema expects for a
      // non-serial-tracked variant.
      const lines = Object.entries(serials)
        .map(([variantId, raw]) => ({ variantId, serials: parseSerials(raw) }))
        .filter((l) => l.serials.length > 0);
      return inventoryApi.sendTransfer(transferId, lines.length > 0 ? lines : undefined);
    },
    onSuccess: async () => {
      setSending(false);
      setError(null);
      setOk(t('transfers.sent'));
      await refresh();
    },
    onError: (e) => {
      setOk(null);
      setError(describeError(e));
    },
  });

  const receive = useMutation({
    mutationFn: (transfer: StockTransfer) =>
      inventoryApi.receiveTransfer(
        transferId,
        transfer.items.map((item) => {
          const raw = serials[item.variantId] ?? '';
          const parsed = parseSerials(raw);
          const qty = received[item.variantId];
          return {
            variantId: item.variantId,
            // Defaults to everything that was shipped; a short receipt is
            // typed explicitly, and the remainder stays IN_TRANSIT.
            quantityReceived: qty === undefined || qty === '' ? Number(item.quantity) : Number(qty),
            ...(parsed.length > 0 ? { serials: parsed } : {}),
          };
        }),
      ),
    onSuccess: async () => {
      setReceiving(false);
      setError(null);
      setOk(t('transfers.received'));
      await refresh();
    },
    onError: (e) => {
      setOk(null);
      setError(describeError(e));
    },
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

  const transfer = detail.data!.data;

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold text-neutral-900">{t('transfers.transfer')}</h1>
            <Badge tone={transferTone(transfer.status)}>{t(`transfers.statusLabel.${transfer.status}`)}</Badge>
          </div>
          <p className="text-xs text-neutral-500">
            {transfer.sourceWarehouse?.name ?? '—'} → {transfer.destinationWarehouse?.name ?? '—'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/inventory/transfers')}>
          {t('transfers.backToList')}
        </Button>
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="transfer-result">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}

      <Card className="mb-4">
        <CardBody className="grid grid-cols-1 gap-x-6 gap-y-1 p-4 sm:grid-cols-2">
          <Fact label={t('transfers.created')} value={formatDateTime(transfer.createdAt)} />
          <Fact label={t('transfers.sentAt')} value={transfer.sentAt ? formatDateTime(transfer.sentAt) : '—'} />
          <Fact label={t('transfers.receivedAt')} value={transfer.receivedAt ? formatDateTime(transfer.receivedAt) : '—'} />
        </CardBody>
      </Card>

      <DataTable
        data-testid="transfer-items"
        rows={transfer.items}
        rowKey={(i) => i.id}
        empty={t('transfers.noItems')}
        columns={[
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (i: TransferItem) => i.variant?.sku ?? i.variantId },
          { key: 'qty', header: t('transfers.quantitySent'), align: 'end', className: 'numeric', cell: (i) => i.quantity },
          {
            key: 'recv',
            header: t('transfers.quantityReceived'),
            align: 'end',
            className: 'numeric',
            cell: (i) => i.quantityReceived ?? '—',
          },
          {
            key: 'outstanding',
            header: t('transfers.outstanding'),
            align: 'end',
            className: 'numeric',
            // Stock that was sent and never arrived. Visible on a
            // COMPLETED transfer precisely because completion does not
            // mean everything turned up.
            cell: (i) => {
              if (i.quantityReceived === null) return '—';
              const missing = outstandingQuantity(i);
              return missing > 0 ? <span className="font-bold text-warning-700">{missing}</span> : '—';
            },
          },
        ]}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        {canSend && canSendTransfer(transfer) && (
          <Button onClick={() => setSending(true)} data-testid="send-transfer">
            {t('transfers.send')}
          </Button>
        )}
        {canReceive && canReceiveTransfer(transfer) && (
          <Button onClick={() => setReceiving(true)} data-testid="receive-transfer">
            {t('transfers.receive')}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={sending}
        tone="danger"
        title={t('transfers.send')}
        message={t('transfers.sendWarning')}
        confirmLabel={t('transfers.send')}
        cancelLabel={t('common.cancel')}
        pending={send.isPending}
        onConfirm={() => send.mutate()}
        onClose={() => setSending(false)}
        data-testid="send-dialog"
      >
        <p className="text-xs leading-snug text-neutral-500">{t('transfers.serialsHint')}</p>
        {transfer.items.map((item) => (
          <Input
            key={item.id}
            label={t('transfers.serialsFor', { sku: item.variant?.sku ?? item.variantId, quantity: item.quantity })}
            value={serials[item.variantId] ?? ''}
            onChange={(e) => setSerials({ ...serials, [item.variantId]: e.target.value })}
            data-testid={`send-serials-${item.variant?.sku ?? item.variantId}`}
          />
        ))}
      </ConfirmDialog>

      <ConfirmDialog
        open={receiving}
        title={t('transfers.receive')}
        message={t('transfers.receiveWarning')}
        confirmLabel={t('transfers.receive')}
        cancelLabel={t('common.cancel')}
        pending={receive.isPending}
        onConfirm={() => receive.mutate(transfer)}
        onClose={() => setReceiving(false)}
        data-testid="receive-dialog"
      >
        {transfer.items.map((item) => (
          <div key={item.id} className="flex flex-col gap-1">
            <Input
              label={t('transfers.receivedFor', { sku: item.variant?.sku ?? item.variantId, quantity: item.quantity })}
              type="number"
              min="0"
              step="0.0001"
              placeholder={item.quantity}
              value={received[item.variantId] ?? ''}
              onChange={(e) => setReceived({ ...received, [item.variantId]: e.target.value })}
              data-testid={`receive-qty-${item.variant?.sku ?? item.variantId}`}
            />
            <Input
              label={t('transfers.serialsReceived')}
              value={serials[item.variantId] ?? ''}
              onChange={(e) => setSerials({ ...serials, [item.variantId]: e.target.value })}
              data-testid={`receive-serials-${item.variant?.sku ?? item.variantId}`}
            />
          </div>
        ))}
      </ConfirmDialog>
    </div>
  );
}

/** Serials are typed as a free list. Splitting is all this does — every
 *  question about whether a serial is real, in stock, or in this
 *  warehouse is the server's. */
function parseSerials(raw: string): string[] {
  return raw
    .split(/[\s,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-neutral-100 py-1 text-sm last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className="font-medium text-neutral-800">{value}</span>
    </div>
  );
}
