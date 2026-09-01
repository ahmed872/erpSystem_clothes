import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, ConfirmDialog, DataTable, ErrorBanner, Input, Select } from '@retail/ui-kit';
import { inventoryApi } from '../api/inventory';
import { catalogApi } from '../api/catalog';
import { describeError } from '../lib/apiClient';
import { formatDateTime } from '../lib/datetime';
import { transferTone } from '../lib/inventory';
import { usePermission } from '../hooks/usePermission';
import type { StockTransfer } from '../lib/apiTypes';

/**
 * Phase 15 — STOCK TRANSFERS between warehouses.
 *
 * THREE GRANTS, THREE STATES, THREE CONTROLS. `transfer_create` makes a
 * DRAFT, `transfer_send` ships it, `transfer_receive` books it in. The
 * backend splits them deliberately — the person who plans a move is not
 * always the one who packs the box or the one who opens it — so this
 * screen keeps them apart rather than offering one "do the transfer".
 *
 * A DRAFT MOVES NOTHING AND RESERVES NOTHING. Availability is not even
 * checked until the send, which is where the engine takes its row lock.
 * The browser therefore makes no promise about whether a draft can be
 * fulfilled; asking it to would be a stock calculation.
 */
export function TransfersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canCreate = usePermission('inventory.transfer_create');
  const canSeeWarehouses = usePermission('warehouses.view');

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  const transfers = useQuery({ queryKey: ['transfers'], queryFn: () => inventoryApi.listTransfers() });
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => inventoryApi.listWarehouses(),
    enabled: canSeeWarehouses && creating,
  });
  const products = useQuery({
    queryKey: ['products', 'transferable'],
    queryFn: () => catalogApi.listProducts({ status: 'ACTIVE', limit: 100 }),
    enabled: creating,
  });

  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [items, setItems] = useState<{ variantId: string; quantity: string }[]>([]);
  const [candidate, setCandidate] = useState('');
  const [quantity, setQuantity] = useState('1');

  const create = useMutation({
    mutationFn: () =>
      inventoryApi.createTransfer({
        sourceWarehouseId: source,
        destinationWarehouseId: destination,
        items: items.map((i) => ({ variantId: i.variantId, quantity: Number(i.quantity) })),
      }),
    onSuccess: async (res) => {
      setCreating(false);
      setItems([]);
      setSource('');
      setDestination('');
      await queryClient.invalidateQueries({ queryKey: ['transfers'] });
      navigate(`/inventory/transfers/${res.data.id}`);
    },
    onError: (e) => setError(describeError(e)),
  });

  const variantOptions = (products.data?.data ?? []).flatMap((p) =>
    p.variants.filter((v) => v.status === 'ACTIVE').map((v) => ({ id: v.id, label: `${p.name} · ${v.sku}` })),
  );
  const warehouseList = warehouses.data?.data ?? [];

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('transfers.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('transfers.explainer')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)} data-testid="new-transfer">
            {t('transfers.newTransfer')}
          </Button>
        )}
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {transfers.isError && <ErrorBanner {...describeError(transfers.error)} />}

      <DataTable
        data-testid="transfers-table"
        loading={transfers.isLoading}
        rows={transfers.data?.data ?? []}
        rowKey={(x) => x.id}
        empty={t('transfers.none')}
        onRowClick={(x) => navigate(`/inventory/transfers/${x.id}`)}
        columns={[
          { key: 'created', header: t('transfers.created'), cell: (x: StockTransfer) => formatDateTime(x.createdAt) },
          { key: 'from', header: t('transfers.from'), cell: (x) => x.sourceWarehouse?.name ?? '—' },
          { key: 'to', header: t('transfers.to'), cell: (x) => x.destinationWarehouse?.name ?? '—' },
          { key: 'lines', header: t('transfers.lines'), align: 'end', className: 'numeric', cell: (x) => String(x.items.length) },
          {
            key: 'status',
            header: t('transfers.status'),
            cell: (x) => <Badge tone={transferTone(x.status)}>{t(`transfers.statusLabel.${x.status}`)}</Badge>,
          },
        ]}
      />

      <ConfirmDialog
        open={creating}
        title={t('transfers.newTransfer')}
        message={t('transfers.newTransferHint')}
        confirmLabel={t('common.create')}
        cancelLabel={t('common.cancel')}
        pending={create.isPending}
        onConfirm={() => create.mutate()}
        onClose={() => setCreating(false)}
        data-testid="create-transfer-dialog"
      >
        <Select label={t('transfers.from')} value={source} onChange={(e) => setSource(e.target.value)} data-testid="transfer-source">
          <option value="">{t('transfers.selectWarehouse')}</option>
          {warehouseList.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Select
          label={t('transfers.to')}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          data-testid="transfer-destination"
        >
          <option value="">{t('transfers.selectWarehouse')}</option>
          {/* Same-warehouse is refused by the schema; not offering it
              avoids a certain 422. The server re-checks regardless. */}
          {warehouseList.filter((w) => w.id !== source).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>

        {items.map((item, idx) => (
          <div key={item.variantId} className="flex items-center gap-2 rounded-lg border border-neutral-200 p-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              {variantOptions.find((v) => v.id === item.variantId)?.label ?? item.variantId}
            </span>
            <Input
              type="number"
              min="0.0001"
              step="0.0001"
              value={item.quantity}
              onChange={(e) => {
                const next = [...items];
                next[idx] = { ...item, quantity: e.target.value };
                setItems(next);
              }}
              className="w-24"
            />
            <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, i) => i !== idx))}>
              {t('common.remove')}
            </Button>
          </div>
        ))}

        <div className="flex flex-wrap items-end gap-2">
          <Select value={candidate} onChange={(e) => setCandidate(e.target.value)} data-testid="transfer-variant">
            <option value="">{t('catalogue.selectVariant')}</option>
            {variantOptions
              .filter((v) => !items.some((i) => i.variantId === v.id))
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
          </Select>
          <Input
            type="number"
            min="0.0001"
            step="0.0001"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-24"
            data-testid="transfer-quantity"
          />
          <Button
            variant="secondary"
            disabled={!candidate}
            onClick={() => {
              setItems([...items, { variantId: candidate, quantity: quantity || '1' }]);
              setCandidate('');
              setQuantity('1');
            }}
            data-testid="transfer-add-item"
          >
            {t('common.add')}
          </Button>
        </div>
      </ConfirmDialog>
    </div>
  );
}
