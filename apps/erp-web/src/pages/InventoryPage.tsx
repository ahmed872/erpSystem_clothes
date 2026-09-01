import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  DataTable,
  ErrorBanner,
  Input,
  Select,
  Tabs,
} from '@retail/ui-kit';
import type { TabDef } from '@retail/ui-kit';
import { inventoryApi } from '../api/inventory';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDateTime, formatDate } from '../lib/datetime';
import { pageWindow } from '../lib/catalogue';
import {
  ADJUSTMENT_TYPES,
  balanceHasCost,
  hasReservation,
  isDepleted,
  isManualMovement,
  movementDirection,
  movementHasCost,
  movementTone,
  serialTone,
} from '../lib/inventory';
import { usePermission } from '../hooks/usePermission';
import type { AdjustmentType, SerialStatus, StockBalance, StockMovement, StockMovementType } from '../lib/apiTypes';

/**
 * Phase 15 — INVENTORY.
 *
 * FIVE READS AND ONE MUTATION, all already in the backend. What did not
 * exist was any way to see stock outside a REST client.
 *
 * NOTHING ON THESE SCREENS COMPUTES A QUANTITY. `availableQuantity` is
 * `quantityOnHand - quantityReserved` computed server-side; an
 * adjustment's resulting `quantityOnHand` comes back from the engine
 * under its own row lock. There is deliberately no "this will leave you
 * with N" preview: it would be a second inventory engine, and it would
 * disagree with the real one exactly when it matters — under concurrency.
 *
 * COST APPEARS ONLY WHERE COST ARRIVED. The server deletes `averageCost`
 * from balances, `unitCostAtMovement` from movements, and — as of this
 * milestone — `averageCost`/`cogsPerUnit` from every mutation result, for
 * a caller without `products.view_cost`. A BRANCH_MANAGER holds
 * `inventory.view` and not that, and genuinely receives no such key.
 */
export function InventoryPage() {
  const { t } = useTranslation();
  const canSeeWarehouses = usePermission('warehouses.view');

  const tabs: TabDef[] = [
    { id: 'balances', label: t('inventory.tabs.balances') },
    { id: 'movements', label: t('inventory.tabs.movements') },
    { id: 'serials', label: t('inventory.tabs.serials') },
    { id: 'lots', label: t('inventory.tabs.lots') },
    { id: 'integrity', label: t('inventory.tabs.integrity') },
  ];
  const [active, setActive] = useState('balances');

  // The warehouse filter is `warehouses.view`, a SEPARATE grant from
  // `inventory.view` — a CASHIER holds the latter and not the former.
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => inventoryApi.listWarehouses(),
    enabled: canSeeWarehouses,
  });
  const warehouseOptions = warehouses.data?.data ?? [];

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('inventory.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('inventory.explainer')}</p>

      <Tabs tabs={tabs} active={active} onChange={setActive} data-testid="inventory-tabs">
        {active === 'balances' && <BalancesTab warehouses={warehouseOptions} canFilterWarehouse={canSeeWarehouses} />}
        {active === 'movements' && <MovementsTab warehouses={warehouseOptions} canFilterWarehouse={canSeeWarehouses} />}
        {active === 'serials' && <SerialsTab />}
        {active === 'lots' && <LotsTab />}
        {active === 'integrity' && <IntegrityTab />}
      </Tabs>
    </div>
  );
}

// ==================================================== balances ==========
function BalancesTab({
  warehouses,
  canFilterWarehouse,
}: {
  warehouses: { id: string; name: string }[];
  canFilterWarehouse: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canAdjust = usePermission('inventory.adjust');
  const canCount = usePermission('inventory.stock_count_create');

  const [warehouseId, setWarehouseId] = useState('');
  const [adjusting, setAdjusting] = useState<StockBalance | null>(null);
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [result, setResult] = useState<{ quantityOnHand: string; averageCost?: string } | null>(null);

  const balances = useQuery({
    queryKey: ['balances', warehouseId],
    queryFn: () => inventoryApi.balances({ warehouseId: warehouseId || undefined }),
  });
  const rows = balances.data?.data ?? [];
  const showsCost = rows.some(balanceHasCost);

  const createCount = useMutation({
    mutationFn: () => inventoryApi.createCount({ warehouseId }),
    onSuccess: (res) => navigate(`/inventory/counts/${res.data.id}`),
    onError: (e) => setError(describeError(e)),
  });

  return (
    <div>
      <Card className="mb-3">
        <CardBody className="flex flex-wrap items-end gap-3 p-3">
          {canFilterWarehouse && (
            <Select
              label={t('inventory.warehouse')}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              data-testid="balance-warehouse"
            >
              <option value="">{t('inventory.allWarehouses')}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
          {canCount && (
            <Button
              variant="secondary"
              disabled={!warehouseId}
              onClick={() => setCounting(true)}
              data-testid="start-count"
            >
              {t('inventory.startCount')}
            </Button>
          )}
          <p className="mb-2 text-xs text-neutral-500">
            {canCount ? t('inventory.countHint') : t('inventory.balancesHint')}
          </p>
        </CardBody>
      </Card>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {balances.isError && <ErrorBanner {...describeError(balances.error)} />}
      {result && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="adjust-result">
          {/* THE SERVER'S figure, rendered as it came back. */}
          <p className="text-sm font-semibold text-success-700">
            {t('inventory.adjusted', { quantity: result.quantityOnHand })}
          </p>
          {result.averageCost !== undefined && (
            <p className="mt-0.5 text-xs text-neutral-600" data-testid="adjust-result-cost">
              {t('inventory.averageCost')}: {formatMoney(result.averageCost)}
            </p>
          )}
        </div>
      )}

      <DataTable
        data-testid="balances-table"
        loading={balances.isLoading}
        rows={rows}
        rowKey={(b) => b.id}
        empty={t('inventory.noBalances')}
        columns={[
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (b: StockBalance) => b.variant.sku },
          { key: 'product', header: t('catalogue.name'), cell: (b) => b.variant.product.name },
          { key: 'warehouse', header: t('inventory.warehouse'), cell: (b) => b.warehouse.name },
          {
            key: 'onHand',
            header: t('inventory.onHand'),
            align: 'end',
            className: 'numeric',
            cell: (b) => b.quantityOnHand,
          },
          {
            key: 'reserved',
            header: t('inventory.reserved'),
            align: 'end',
            className: 'numeric',
            // Displayed, never editable: nothing in the backend writes it.
            cell: (b) => (hasReservation(b) ? b.quantityReserved : '—'),
          },
          {
            key: 'available',
            header: t('inventory.available'),
            align: 'end',
            className: 'numeric',
            cell: (b) => (
              <span className={isDepleted(b) ? 'font-bold text-danger-700' : ''}>{b.availableQuantity}</span>
            ),
          },
          ...(showsCost
            ? [
                {
                  key: 'cost',
                  header: t('inventory.averageCost'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (b: StockBalance) => (b.averageCost === undefined ? '—' : formatMoney(b.averageCost)),
                },
              ]
            : []),
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (b) =>
              canAdjust ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAdjusting(b);
                    setResult(null);
                    setError(null);
                  }}
                  // Keyed on the BALANCE row, not the SKU: a balance is
                  // (warehouse, variant), so the same SKU legitimately
                  // appears once per warehouse it is stocked in.
                  data-testid={`adjust-${b.id}`}
                >
                  {t('inventory.adjust')}
                </Button>
              ) : null,
          },
        ]}
      />

      {adjusting && (
        <AdjustDialog
          balance={adjusting}
          onClose={() => setAdjusting(null)}
          onError={(e) => setError(describeError(e))}
          onDone={async (r) => {
            setResult(r);
            setAdjusting(null);
            setError(null);
            await queryClient.invalidateQueries({ queryKey: ['balances'] });
            await queryClient.invalidateQueries({ queryKey: ['movements'] });
          }}
        />
      )}

      <ConfirmDialog
        open={counting}
        title={t('inventory.startCount')}
        message={t('inventory.startCountWarning')}
        confirmLabel={t('inventory.startCount')}
        cancelLabel={t('common.cancel')}
        pending={createCount.isPending}
        onConfirm={() => createCount.mutate()}
        onClose={() => setCounting(false)}
        data-testid="count-dialog"
      />
    </div>
  );
}

/**
 * A stock adjustment. DELIBERATELY NOT A "SET STOCK TO" FORM: the backend
 * takes a SIGNED DELTA and a mandatory reason, which is what makes an
 * adjustment auditable and distinguishable from a sale. Asking for the
 * new total would mean subtracting in the browser — a stale balance would
 * then silently write the wrong delta.
 */
function AdjustDialog({
  balance,
  onClose,
  onDone,
  onError,
}: {
  balance: StockBalance;
  onClose: () => void;
  onDone: (r: { quantityOnHand: string; averageCost?: string }) => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [quantity, setQuantity] = useState('');
  const [movementType, setMovementType] = useState<AdjustmentType>('ADJUSTMENT');
  const [reason, setReason] = useState('');

  const adjust = useMutation({
    mutationFn: () =>
      inventoryApi.adjust({
        warehouseId: balance.warehouseId,
        variantId: balance.variantId,
        quantity: Number(quantity),
        movementType,
        reason: reason.trim(),
      }),
    onSuccess: (res) => onDone(res.data),
    onError,
  });

  return (
    <ConfirmDialog
      open
      tone="danger"
      title={t('inventory.adjustTitle', { sku: balance.variant.sku })}
      message={t('inventory.adjustWarning')}
      confirmLabel={t('inventory.adjust')}
      cancelLabel={t('common.cancel')}
      pending={adjust.isPending}
      onConfirm={() => adjust.mutate()}
      onClose={onClose}
      data-testid="adjust-dialog"
    >
      <p className="text-xs text-neutral-500">
        {t('inventory.onHand')}: <span className="numeric font-semibold">{balance.quantityOnHand}</span>
      </p>
      <Input
        label={t('inventory.signedQuantity')}
        type="number"
        step="0.0001"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        data-testid="adjust-quantity"
      />
      <Select
        label={t('inventory.movementType')}
        value={movementType}
        onChange={(e) => setMovementType(e.target.value as AdjustmentType)}
        data-testid="adjust-type"
      >
        {ADJUSTMENT_TYPES.map((type) => (
          <option key={type} value={type}>
            {t(`inventory.movementLabel.${type}`)}
          </option>
        ))}
      </Select>
      {/* Required by the schema, not merely encouraged. */}
      <Input
        label={t('inventory.reason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        data-testid="adjust-reason"
      />
    </ConfirmDialog>
  );
}

// =================================================== movements ==========
function MovementsTab({
  warehouses,
  canFilterWarehouse,
}: {
  warehouses: { id: string; name: string }[];
  canFilterWarehouse: boolean;
}) {
  const { t } = useTranslation();
  const [warehouseId, setWarehouseId] = useState('');
  const [movementType, setMovementType] = useState<'' | StockMovementType>('');
  const [page, setPage] = useState(1);

  // The ONE paginated inventory read. Filters and paging are the
  // server's; nothing is narrowed in the browser.
  const movements = useQuery({
    queryKey: ['movements', warehouseId, movementType, page],
    queryFn: () =>
      inventoryApi.movements({
        warehouseId: warehouseId || undefined,
        movementType: movementType || undefined,
        page,
      }),
    placeholderData: keepPreviousData,
  });

  const rows = movements.data?.data ?? [];
  const pagination = movements.data?.pagination;
  const showsCost = rows.some(movementHasCost);

  const TYPES: StockMovementType[] = [
    'OPENING_BALANCE', 'PURCHASE', 'SALE', 'SALES_RETURN', 'PURCHASE_RETURN',
    'TRANSFER_OUT', 'TRANSFER_IN', 'STOCK_COUNT', 'ADJUSTMENT', 'DAMAGE',
    'LOSS', 'INTERNAL_CONSUMPTION', 'EXPIRY', 'BUNDLE_CONSUMPTION', 'AUTHORIZED_CORRECTION',
  ];

  return (
    <div>
      <Card className="mb-3">
        <CardBody className="flex flex-wrap items-end gap-3 p-3">
          {canFilterWarehouse && (
            <Select
              label={t('inventory.warehouse')}
              value={warehouseId}
              onChange={(e) => {
                setWarehouseId(e.target.value);
                setPage(1);
              }}
              data-testid="movement-warehouse"
            >
              <option value="">{t('inventory.allWarehouses')}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
          <Select
            label={t('inventory.movementType')}
            value={movementType}
            onChange={(e) => {
              setMovementType(e.target.value as StockMovementType | '');
              setPage(1);
            }}
            data-testid="movement-type"
          >
            <option value="">{t('inventory.allTypes')}</option>
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`inventory.movementLabel.${type}`)}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      {movements.isError && <ErrorBanner {...describeError(movements.error)} />}

      <DataTable
        data-testid="movements-table"
        loading={movements.isLoading}
        rows={rows}
        rowKey={(m) => m.id}
        empty={t('inventory.noMovements')}
        columns={[
          { key: 'when', header: t('inventory.when'), cell: (m: StockMovement) => formatDateTime(m.createdAt) },
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (m) => m.variant.sku },
          { key: 'warehouse', header: t('inventory.warehouse'), cell: (m) => m.warehouse.name },
          {
            key: 'type',
            header: t('inventory.movementType'),
            cell: (m) => (
              <span className="flex items-center gap-1">
                <Badge tone={movementTone(m.movementType)}>{t(`inventory.movementLabel.${m.movementType}`)}</Badge>
                {/* A deliberate act reads differently from a sale's side effect. */}
                {isManualMovement(m.movementType) && (
                  <span className="text-[10px] text-neutral-400">{t('inventory.manual')}</span>
                )}
              </span>
            ),
          },
          {
            key: 'qty',
            header: t('inventory.quantity'),
            align: 'end',
            className: 'numeric',
            // The SIGN is the server's; direction is read from it, never
            // guessed from the movement type.
            cell: (m) => (
              <span className={movementDirection(m) === 'OUT' ? 'text-danger-700' : 'text-success-700'}>
                {m.quantityBase}
              </span>
            ),
          },
          ...(showsCost
            ? [
                {
                  key: 'cost',
                  header: t('inventory.unitCost'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (m: StockMovement) =>
                    m.unitCostAtMovement === undefined ? '—' : formatMoney(m.unitCostAtMovement),
                },
              ]
            : []),
          { key: 'reason', header: t('inventory.reason'), cell: (m) => m.reason ?? '—' },
        ]}
      />

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="movement-pagination">
          <p className="text-xs text-neutral-500">
            {t('inventory.movementPage', {
              page: pagination.page,
              totalPages: pagination.totalPages,
              total: pagination.total,
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={pagination.page <= 1} onClick={() => setPage(pagination.page - 1)}>
              {t('catalogue.previous')}
            </Button>
            {pageWindow(pagination.page, pagination.totalPages).map((p) => (
              <Button key={p} size="sm" variant={p === pagination.page ? 'primary' : 'ghost'} onClick={() => setPage(p)}>
                {String(p)}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage(pagination.page + 1)}
            >
              {t('catalogue.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===================================================== serials ==========
function SerialsTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'' | SerialStatus>('');

  // The backend filters serials by variant and/or status only. There is
  // no warehouse filter on this contract and none is faked here.
  const serials = useQuery({
    queryKey: ['serials', status],
    queryFn: () => inventoryApi.serials({ status: status || undefined }),
  });

  const STATUSES: SerialStatus[] = [
    'IN_STOCK', 'RESERVED', 'SOLD', 'DAMAGED', 'RETURNED', 'IN_TRANSIT', 'RETURNED_TO_SUPPLIER',
  ];

  return (
    <div>
      <Card className="mb-3">
        <CardBody className="flex flex-wrap items-end gap-3 p-3">
          <Select
            label={t('inventory.serialStatus')}
            value={status}
            onChange={(e) => setStatus(e.target.value as SerialStatus | '')}
            data-testid="serial-status"
          >
            <option value="">{t('inventory.allStatuses')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`inventory.serialLabel.${s}`)}
              </option>
            ))}
          </Select>
          <p className="mb-2 text-xs text-neutral-500">{t('inventory.serialsHint')}</p>
        </CardBody>
      </Card>

      {serials.isError && <ErrorBanner {...describeError(serials.error)} />}

      <DataTable
        data-testid="serials-table"
        loading={serials.isLoading}
        rows={serials.data?.data ?? []}
        rowKey={(s) => s.id}
        empty={t('inventory.noSerials')}
        columns={[
          { key: 'serial', header: t('inventory.serial'), className: 'numeric', cell: (s) => s.serial },
          {
            key: 'status',
            header: t('inventory.serialStatus'),
            // Rendered from the SERVER's status. The browser never infers
            // where a unit is or whether it is sellable.
            cell: (s) => <Badge tone={serialTone(s.status)}>{t(`inventory.serialLabel.${s.status}`)}</Badge>,
          },
          { key: 'created', header: t('inventory.registered'), cell: (s) => formatDateTime(s.createdAt) },
          { key: 'updated', header: t('inventory.lastMoved'), cell: (s) => formatDateTime(s.updatedAt) },
        ]}
      />
    </div>
  );
}

// ======================================================== lots ==========
function LotsTab() {
  const { t } = useTranslation();
  const lots = useQuery({ queryKey: ['lots'], queryFn: () => inventoryApi.lots() });

  return (
    <div>
      {/* Stated in the product because it is genuinely surprising: a lot
          row carries no quantity. "How much of lot X is left" is the
          movement ledger's answer, not this table's. */}
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('inventory.lotsHint')}</p>

      {lots.isError && <ErrorBanner {...describeError(lots.error)} />}

      <DataTable
        data-testid="lots-table"
        loading={lots.isLoading}
        rows={lots.data?.data ?? []}
        rowKey={(l) => l.id}
        empty={t('inventory.noLots')}
        columns={[
          { key: 'lot', header: t('inventory.lotNumber'), className: 'numeric', cell: (l) => l.lotNumber },
          {
            key: 'manufactured',
            header: t('inventory.manufactured'),
            cell: (l) => (l.manufacturingDate ? formatDate(l.manufacturingDate) : '—'),
          },
          { key: 'expiry', header: t('inventory.expiry'), cell: (l) => (l.expiryDate ? formatDate(l.expiryDate) : '—') },
          { key: 'created', header: t('inventory.registered'), cell: (l) => formatDateTime(l.createdAt) },
        ]}
      />
    </div>
  );
}

// =================================================== integrity ==========
/**
 * `GET /inventory/reconciliation` recomputes every cached balance from the
 * append-only movement ledger and reports where the two disagree. A clean
 * result is the normal one and is stated as such, because an empty table
 * would otherwise read as "nothing checked".
 */
function IntegrityTab() {
  const { t } = useTranslation();
  const check = useQuery({ queryKey: ['reconciliation'], queryFn: () => inventoryApi.reconciliation() });
  const result = check.data?.data;

  return (
    <div>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('inventory.integrityHint')}</p>
      {check.isError && <ErrorBanner {...describeError(check.error)} />}

      {result && (
        <div
          className={`mb-3 rounded-xl border p-3 ${
            result.discrepancies.length === 0 ? 'border-success-200 bg-success-50' : 'border-danger-200 bg-danger-50'
          }`}
          data-testid="integrity-banner"
        >
          <p className="text-xs font-semibold text-neutral-800">
            {result.discrepancies.length === 0
              ? t('inventory.integrityClean', { checked: result.checked })
              : t('inventory.integrityDirty', { count: result.discrepancies.length, checked: result.checked })}
          </p>
        </div>
      )}

      <DataTable
        data-testid="integrity-table"
        loading={check.isLoading}
        rows={result?.discrepancies ?? []}
        rowKey={(d) => `${d.warehouseId}:${d.variantId}`}
        empty={t('inventory.noDiscrepancies')}
        columns={[
          { key: 'cached', header: t('inventory.cachedBalance'), align: 'end', className: 'numeric', cell: (d) => d.cachedQuantityOnHand },
          { key: 'ledger', header: t('inventory.ledgerBalance'), align: 'end', className: 'numeric', cell: (d) => d.computedFromLedger },
          { key: 'diff', header: t('inventory.difference'), align: 'end', className: 'numeric', cell: (d) => d.difference },
        ]}
      />
    </div>
  );
}
