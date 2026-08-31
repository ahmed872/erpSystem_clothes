import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, EmptyState, ErrorBanner, Modal, Spinner } from '@retail/ui-kit';
import { holdsApi } from '../api/holds';
import { catalogApi } from '../api/catalog';
import { customersApi } from '../api/customers';
import { describeError } from '../lib/apiClient';
import { holdUnitCount, indicativeValue } from '../lib/holdItems';
import { formatMoney, parseMoney } from '../lib/money';
import { usePermission } from '../hooks/usePermission';
import { useCartStore, type CartLine } from '../store/cartStore';
import { useShiftStore } from '../store/shiftStore';
import type { Customer, HeldSale, HeldSaleStatus } from '../lib/apiTypes';

/**
 * Phase 12 (Held Sales) — the shelf behind the till.
 *
 * A PARKED BASKET IS NOT A SALE, and this screen is built so a cashier can
 * never mistake one for the other. It lives on its own route (never in the
 * sales list), every basket is badged with its state, and the only figure
 * shown is labelled an indication rather than a total — because a hold
 * stores inputs and the real total does not exist until the basket is
 * picked up and priced by the server.
 *
 * RESUMING DOES NOT HAPPEN HERE. This screen loads the basket into the
 * ordinary POS cart and sends the cashier to the ordinary till, where the
 * ordinary Sale Quote prices it and the ordinary checkout takes the money.
 * That is the whole point: there is exactly one way to sell something in
 * this app, and a resumed basket goes down it.
 */
export function HeldSalesPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HeldSaleStatus>('OPEN');
  const activeShift = useShiftStore((s) => s.activeShift);

  const query = useQuery({
    queryKey: ['held-sales', status, activeShift?.warehouseId],
    queryFn: () => holdsApi.list(status, activeShift?.warehouseId),
    enabled: Boolean(activeShift),
  });

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-neutral-900">{t('holds.title')}</h1>
        <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
          {(['OPEN', 'RESUMED', 'VOIDED'] as HeldSaleStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                status === s ? 'bg-white text-brand-700 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'
              }`}
              data-testid={`hold-filter-${s}`}
            >
              {t(`holds.status.${s}`)}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('holds.notASaleNotice')}</p>

      {query.isLoading && (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      )}
      {query.isError && <ErrorBanner {...describeError(query.error)} />}
      {query.data && query.data.data.length === 0 && <EmptyState title={t('holds.empty')} />}

      <ul className="flex flex-col gap-2">
        {query.data?.data.map((hold) => (
          <li key={hold.id}>
            <HeldSaleCard hold={hold} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ====================================================================
function HeldSaleCard({ hold }: { hold: HeldSale }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const loadHold = useCartStore((s) => s.loadHold);
  const activeShift = useShiftStore((s) => s.activeShift);
  const canSell = usePermission('sales.create');

  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  const isOpen = hold.status === 'OPEN';
  // Resuming crosses warehouses only in the sense that it cannot: the sale
  // would be made from the basket's own warehouse, which is not the one
  // this till is standing at. Better to say so than to sell the wrong
  // shop's stock.
  const wrongWarehouse = Boolean(activeShift) && hold.warehouseId !== activeShift!.warehouseId;

  const voidMutation = useMutation({
    mutationFn: () => holdsApi.void(hold.id, t('holds.cancelReason')),
    onSuccess: () => {
      setCancelling(false);
      void queryClient.invalidateQueries({ queryKey: ['held-sales'] });
    },
    onError: (err) => {
      setCancelling(false);
      setError(describeError(err));
    },
  });

  /**
   * PICK THE BASKET UP. The stored lines carry variant ids and numbers
   * only — no product name, because a hold stores a request and not a
   * display. The names are fetched from the catalogue so the cashier reads
   * goods rather than UUIDs, and the customer is re-fetched rather than
   * assumed, so a customer deactivated overnight is the server's problem to
   * report at checkout and not a stale name on screen.
   */
  async function handleResume() {
    setLoading(true);
    setError(null);
    try {
      // Re-read the hold rather than trusting the list row: someone else
      // may have picked it up while this page sat open.
      const { data: fresh } = await holdsApi.get(hold.id);
      if (fresh.status !== 'OPEN') {
        setError({ title: t('holds.noLongerOpen') });
        void queryClient.invalidateQueries({ queryKey: ['held-sales'] });
        return;
      }

      const variants = await Promise.all(fresh.items.map((i) => catalogApi.getVariant(i.variantId)));
      const lines: CartLine[] = fresh.items.map((item, index) => {
        const variant = variants[index].data;
        return {
          key: item.variantId,
          variantId: item.variantId,
          sku: variant.sku,
          productName: variant.product.name,
          variantLabel: variant.attributeValues.map((av) => av.attributeValue.value).join(' / '),
          tracksSerialNumbers: variant.product.tracksSerialNumbers,
          unitPrice: parseMoney(item.unitPrice),
          quantity: parseMoney(item.quantity),
          discountAmount: parseMoney(item.discountAmount),
          serials: item.serials,
        };
      });

      let customer: Customer | null = null;
      if (fresh.customerId) {
        const { data } = await customersApi.get(fresh.customerId);
        customer = data;
      }

      loadHold({ id: fresh.id, holdNumber: fresh.holdNumber, label: fresh.label }, lines, customer);
      navigate('/pos');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="numeric text-sm font-bold text-neutral-900" data-testid={`hold-number-${hold.holdNumber}`}>
                {hold.holdNumber}
              </span>
              <Badge tone={hold.status === 'OPEN' ? 'warning' : hold.status === 'RESUMED' ? 'success' : 'neutral'}>
                {t(`holds.status.${hold.status}`)}
              </Badge>
            </div>
            {hold.label && <p className="mt-0.5 text-sm font-semibold text-brand-700">{hold.label}</p>}
            <p className="text-xs text-neutral-500">
              {t('holds.parkedAt')}: {new Date(hold.createdAt).toLocaleString()}
            </p>
            {hold.notes && <p className="mt-0.5 text-xs text-neutral-500">{hold.notes}</p>}
          </div>
          <div className="text-end">
            <p className="numeric text-sm font-bold text-neutral-800">{formatMoney(indicativeValue(hold.items))}</p>
            <p className="text-[11px] text-neutral-400">{t('holds.indicativeShort')}</p>
          </div>
        </div>

        <p className="text-xs text-neutral-600">
          {t('holds.lineSummary', { lines: hold.items.length, units: holdUnitCount(hold.items) })}
        </p>

        {hold.status === 'RESUMED' && hold.resumedSaleId && (
          <button
            type="button"
            onClick={() => navigate(`/receipt/${hold.resumedSaleId}`)}
            className="self-start text-xs font-medium text-brand-700 hover:underline"
          >
            {t('holds.viewResultingSale')} →
          </button>
        )}

        {wrongWarehouse && isOpen && <p className="text-xs text-warning-700">{t('holds.otherWarehouse')}</p>}

        {error && <ErrorBanner title={error.title} message={error.message} />}

        {isOpen && (
          <div className="flex flex-wrap gap-2">
            {canSell && (
              <Button
                size="sm"
                loading={loading}
                disabled={loading || wrongWarehouse}
                onClick={() => void handleResume()}
                data-testid={`resume-hold-${hold.holdNumber}`}
              >
                {t('holds.resumeAction')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCancelling(true)}
              data-testid={`cancel-hold-${hold.holdNumber}`}
            >
              {t('holds.cancelAction')}
            </Button>
          </div>
        )}
      </CardBody>

      <ConfirmCancelModal
        open={cancelling}
        holdNumber={hold.holdNumber}
        pending={voidMutation.isPending}
        onClose={() => setCancelling(false)}
        onConfirm={() => voidMutation.mutate()}
      />
    </Card>
  );
}

// ====================================================================
/** Abandoning a basket is irreversible and takes no money — the dialog
 * says both, because a cashier pressing it expects neither a refund nor a
 * way back. */
function ConfirmCancelModal({
  open,
  holdNumber,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  holdNumber: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t('holds.cancelTitle')} size="sm">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-700">{t('holds.cancelConfirm', { holdNumber })}</p>
        <p className="text-xs text-neutral-500">{t('holds.cancelNotice')}</p>
        <div className="flex gap-2">
          <Button variant="secondary" fullWidth onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" fullWidth loading={pending} disabled={pending} onClick={onConfirm} data-testid="confirm-cancel-hold">
            {t('holds.cancelAction')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
