import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge, DataTable, ErrorBanner, Input, Select, Tabs } from '@retail/ui-kit';
import { reportsApi } from '../api/reports';
import { inventoryApi } from '../api/inventory';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDateTime } from '../lib/datetime';
import { ADJUSTMENT_TYPES } from '../lib/inventory';
import { damageTone, movementTone, neverSold, rowsCarryCost } from '../lib/reports';
import { Figure, RangeEcho, ReportPager, ReportRangeControl } from '../components/ReportControls';
import type { DamageLossRow, MovementReportRow, SlowMovingRow, ValuationRow } from '../lib/apiTypes';

/**
 * Phase 19 — INVENTORY REPORTS.
 *
 * Four backend reports, and they do NOT share a filter contract — which
 * is why each tab carries its own controls rather than one shared bar:
 *
 *   - VALUATION takes warehouse/branch and NO date range. It is an
 *     as-at-now position; `from`/`to` sent here would be silently dropped.
 *   - MOVEMENTS and DAMAGE & LOSS take a real date range, plus warehouse
 *     and movement type.
 *   - SLOW MOVING takes `days` — not a range. "Slow" is defined by
 *     observed sales activity in the ledger over that many days, which is
 *     the server's definition and is printed verbatim.
 *
 * COST COLUMNS APPEAR ONLY WHEN THE PAYLOAD CARRIED THEM. `averageCost`,
 * `inventoryValue`, `unitCostAtMovement` and `movementValue` are deleted
 * server-side for a caller without `products.view_cost` — a BRANCH_MANAGER
 * reads the same tables with the money columns simply absent.
 */
export function InventoryReportsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'valuation' | 'movements' | 'damage' | 'slow'>('valuation');

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('reports.inventory.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('reports.inventory.explainer')}</p>

      <Tabs
        data-testid="inventory-report-tabs"
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
        tabs={[
          { id: 'valuation', label: t('reports.inventory.valuation') },
          { id: 'movements', label: t('reports.inventory.movements') },
          { id: 'damage', label: t('reports.inventory.damageLoss') },
          { id: 'slow', label: t('reports.inventory.slowMoving') },
        ]}
      >
        {tab === 'valuation' && <ValuationTab />}
        {tab === 'movements' && <MovementsTab />}
        {tab === 'damage' && <DamageTab />}
        {tab === 'slow' && <SlowMovingTab />}
      </Tabs>
    </div>
  );
}

function useWarehouses() {
  return useQuery({ queryKey: ['warehouses'], queryFn: () => inventoryApi.listWarehouses() });
}

function WarehousePicker({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) {
  const { t } = useTranslation();
  const warehouses = useWarehouses();
  return (
    <Select label={t('inventory.warehouse')} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
      <option value="">{t('inventory.allWarehouses')}</option>
      {(warehouses.data?.data ?? []).map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </Select>
  );
}

// ====================================================================
function ValuationTab() {
  const { t } = useTranslation();
  const [warehouseId, setWarehouseId] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['report-valuation', warehouseId, page],
    queryFn: () => reportsApi.valuation({ warehouseId: warehouseId || undefined, page }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const showCost = rowsCarryCost(rows);

  return (
    <div>
      {/* No date control: the contract has none, and an inert one would
          imply a historical valuation the server cannot produce. */}
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <WarehousePicker
          value={warehouseId}
          onChange={(v) => {
            setWarehouseId(v);
            setPage(1);
          }}
          testId="valuation-warehouse"
        />
      </div>
      <p className="mb-3 text-xs text-neutral-500" data-testid="valuation-no-range">
        {t('reports.inventory.valuationAsAtNow')}
      </p>

      {query.isError && <ErrorBanner {...describeError(query.error)} />}

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="valuation-summary">
        <Figure label={t('reports.inventory.variantCount')} value={String(query.data?.summary.variantCount ?? 0)} />
        {query.data?.summary.inventoryValue !== undefined && (
          <Figure
            label={t('reports.inventory.inventoryValue')}
            value={formatMoney(query.data.summary.inventoryValue)}
            testId="figure-inventoryValue"
          />
        )}
      </div>

      <DataTable
        data-testid="valuation-table"
        loading={query.isLoading}
        rows={rows}
        rowKey={(r) => `${r.warehouseId}:${r.variantId}`}
        empty={t('reports.none')}
        columns={[
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (r: ValuationRow) => r.sku },
          { key: 'name', header: t('reports.inventory.product'), cell: (r) => r.productName },
          { key: 'warehouse', header: t('inventory.warehouse'), cell: (r) => r.warehouseName },
          { key: 'qty', header: t('reports.inventory.onHand'), align: 'end', className: 'numeric', cell: (r) => r.quantityOnHand },
          ...(showCost
            ? [
                {
                  key: 'avg',
                  header: t('reports.inventory.averageCost'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (r: ValuationRow) => formatMoney(r.averageCost),
                },
                {
                  key: 'value',
                  header: t('reports.inventory.inventoryValue'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (r: ValuationRow) => formatMoney(r.inventoryValue),
                },
              ]
            : []),
        ]}
      />
      <ReportPager
        page={query.data?.pagination.page ?? 1}
        totalPages={query.data?.pagination.totalPages ?? 1}
        total={query.data?.pagination.total ?? 0}
        onPage={setPage}
        testId="valuation-pager"
      />
    </div>
  );
}

// ====================================================================
function MovementsTab() {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [movementType, setMovementType] = useState('');
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['report-movements', from, to, warehouseId, movementType, page],
    queryFn: () =>
      reportsApi.movements({
        from: from || undefined,
        to: to || undefined,
        warehouseId: warehouseId || undefined,
        movementType: movementType || undefined,
        page,
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const showCost = rowsCarryCost(rows);

  return (
    <div>
      <ReportRangeControl from={from} to={to} onFrom={setFrom} onTo={setTo} testId="movements-range">
        <WarehousePicker
          value={warehouseId}
          onChange={(v) => {
            setWarehouseId(v);
            setPage(1);
          }}
          testId="movements-warehouse"
        />
        <Select
          label={t('inventory.movementType')}
          value={movementType}
          onChange={(e) => {
            setMovementType(e.target.value);
            setPage(1);
          }}
          data-testid="movements-type"
        >
          <option value="">{t('inventory.allTypes')}</option>
          {MOVEMENT_TYPES.map((m) => (
            <option key={m} value={m}>
              {t(`inventory.movementLabel.${m}`, m)}
            </option>
          ))}
        </Select>
      </ReportRangeControl>

      <RangeEcho range={query.data?.range} />
      {query.isError && <ErrorBanner {...describeError(query.error)} />}

      <DataTable
        data-testid="movements-table"
        loading={query.isLoading}
        rows={rows}
        rowKey={(r) => r.id}
        empty={t('reports.none')}
        columns={[
          { key: 'when', header: t('sales.when'), cell: (r: MovementReportRow) => formatDateTime(r.createdAt) },
          {
            key: 'type',
            header: t('inventory.movementType'),
            cell: (r) => <Badge tone={movementTone(r)}>{t(`inventory.movementLabel.${r.movementType}`, r.movementType)}</Badge>,
          },
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (r) => r.sku },
          { key: 'warehouse', header: t('inventory.warehouse'), cell: (r) => r.warehouseName },
          { key: 'qty', header: t('reports.inventory.quantity'), align: 'end', className: 'numeric', cell: (r) => r.quantityBase },
          { key: 'reason', header: t('reports.inventory.reason'), cell: (r) => r.reason ?? '—' },
          ...(showCost
            ? [
                {
                  key: 'value',
                  header: t('reports.inventory.movementValue'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (r: MovementReportRow) => formatMoney(r.movementValue),
                },
              ]
            : []),
        ]}
      />
      <ReportPager
        page={query.data?.pagination.page ?? 1}
        totalPages={query.data?.pagination.totalPages ?? 1}
        total={query.data?.pagination.total ?? 0}
        onPage={setPage}
        testId="movements-pager"
      />
    </div>
  );
}

const MOVEMENT_TYPES = [
  'OPENING_BALANCE',
  'PURCHASE',
  'SALE',
  'SALES_RETURN',
  'PURCHASE_RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT',
  ...ADJUSTMENT_TYPES,
  'BUNDLE_CONSUMPTION',
  'AUTHORIZED_CORRECTION',
].filter((v, i, a) => a.indexOf(v) === i);

// ====================================================================
function DamageTab() {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['report-damage', from, to, page],
    queryFn: () => reportsApi.damageLoss({ from: from || undefined, to: to || undefined, page }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const showCost = rowsCarryCost(rows);

  return (
    <div>
      <ReportRangeControl from={from} to={to} onFrom={setFrom} onTo={setTo} testId="damage-range" />
      <RangeEcho range={query.data?.range} />
      {query.isError && <ErrorBanner {...describeError(query.error)} />}

      {(query.data?.summary.length ?? 0) > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="damage-summary">
          {query.data!.summary.map((s) => (
            <Figure
              key={s.movementType}
              label={t(`inventory.movementLabel.${s.movementType}`, s.movementType)}
              value={s.movementValue !== undefined ? formatMoney(s.movementValue) : s.quantity}
              tone="bad"
            />
          ))}
        </div>
      )}

      <DataTable
        data-testid="damage-table"
        loading={query.isLoading}
        rows={rows}
        rowKey={(r) => r.id}
        empty={t('reports.none')}
        columns={[
          { key: 'when', header: t('sales.when'), cell: (r: DamageLossRow) => formatDateTime(r.createdAt) },
          {
            key: 'type',
            header: t('inventory.movementType'),
            cell: (r) => <Badge tone={damageTone(r)}>{t(`inventory.movementLabel.${r.movementType}`, r.movementType)}</Badge>,
          },
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (r) => r.sku },
          { key: 'name', header: t('reports.inventory.product'), cell: (r) => r.productName },
          { key: 'qty', header: t('reports.inventory.quantity'), align: 'end', className: 'numeric', cell: (r) => r.quantity },
          { key: 'reason', header: t('reports.inventory.reason'), cell: (r) => r.reason ?? '—' },
          ...(showCost
            ? [
                {
                  key: 'value',
                  header: t('reports.inventory.movementValue'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (r: DamageLossRow) => formatMoney(r.movementValue),
                },
              ]
            : []),
        ]}
      />
      <ReportPager
        page={query.data?.pagination.page ?? 1}
        totalPages={query.data?.pagination.totalPages ?? 1}
        total={query.data?.pagination.total ?? 0}
        onPage={setPage}
        testId="damage-pager"
      />
    </div>
  );
}

// ====================================================================
function SlowMovingTab() {
  const { t } = useTranslation();
  const [days, setDays] = useState('90');
  const [warehouseId, setWarehouseId] = useState('');
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['report-slow', days, warehouseId, page],
    queryFn: () => reportsApi.slowMoving({ days: Number(days) || 90, warehouseId: warehouseId || undefined, page }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const showCost = rowsCarryCost(rows);

  return (
    <div>
      {/* `days`, not a date range — the contract's own parameter. */}
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Input
          label={t('reports.inventory.days')}
          type="number"
          min="1"
          max="3650"
          value={days}
          onChange={(e) => {
            setDays(e.target.value);
            setPage(1);
          }}
          data-testid="slow-days"
        />
        <WarehousePicker
          value={warehouseId}
          onChange={(v) => {
            setWarehouseId(v);
            setPage(1);
          }}
          testId="slow-warehouse"
        />
      </div>
      {/* The server's own definition of "slow", printed verbatim. */}
      {query.data?.criteria && (
        <p className="mb-3 text-xs leading-snug text-neutral-500" data-testid="slow-definition">
          {query.data.criteria.definition}
        </p>
      )}

      {query.isError && <ErrorBanner {...describeError(query.error)} />}

      <DataTable
        data-testid="slow-table"
        loading={query.isLoading}
        rows={rows}
        rowKey={(r) => `${r.warehouseId}:${r.variantId}`}
        empty={t('reports.none')}
        columns={[
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (r: SlowMovingRow) => r.sku },
          { key: 'name', header: t('reports.inventory.product'), cell: (r) => r.productName },
          { key: 'warehouse', header: t('inventory.warehouse'), cell: (r) => r.warehouseName },
          { key: 'qty', header: t('reports.inventory.onHand'), align: 'end', className: 'numeric', cell: (r) => r.quantityOnHand },
          {
            key: 'lastSale',
            header: t('reports.inventory.lastSale'),
            cell: (r) => (neverSold(r) ? <Badge tone="danger">{t('reports.inventory.neverSold')}</Badge> : formatDateTime(r.lastSaleAt!)),
          },
          ...(showCost
            ? [
                {
                  key: 'value',
                  header: t('reports.inventory.inventoryValue'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (r: SlowMovingRow) => formatMoney(r.inventoryValue),
                },
              ]
            : []),
        ]}
      />
      <ReportPager
        page={query.data?.pagination.page ?? 1}
        totalPages={query.data?.pagination.totalPages ?? 1}
        total={query.data?.pagination.total ?? 0}
        onPage={setPage}
        testId="slow-pager"
      />
    </div>
  );
}
