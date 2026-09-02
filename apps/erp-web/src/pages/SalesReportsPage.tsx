import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge, DataTable, ErrorBanner, Select, Spinner, Tabs } from '@retail/ui-kit';
import { reportsApi } from '../api/reports';
import type { SalesDimension } from '../api/reports';
import { inventoryApi } from '../api/inventory';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDateTime } from '../lib/datetime';
import {
  dimensionHasOnlyRevenue,
  dimensionSupportsWarehouse,
  hasCogs,
  hasGrossProfit,
  isWalkInReturn,
  rowsCarryCost,
  rowsCarryProfit,
} from '../lib/reports';
import { Figure, Limitations, RangeEcho, ReportPager, ReportRangeControl } from '../components/ReportControls';
import type { DimensionRow, SalesReturnReportRow } from '../lib/apiTypes';

/**
 * Phase 19 — SALES REPORTS.
 *
 * Seven backend reports behind one screen, because they answer one
 * question — "what did we sell in this window" — sliced five ways plus a
 * summary and a returns list. Each tab is its own request against its own
 * endpoint; nothing is re-aggregated here.
 *
 * COST AND PROFIT APPEAR ONLY IF THE RESPONSE CARRIED THEM. The server
 * DELETES `cogs` and `grossProfit` for a caller without
 * `products.view_cost` / `reports.view_profit`, so the columns are
 * decided by inspecting the payload — never by checking a permission in
 * the browser, which a client-side branch could be flipped to defeat.
 *
 * THE WINDOW IS THE SERVER'S. Two calendar dates go up; the resolved
 * half-open interval and the business timezone come back and are printed.
 */
const DIMENSIONS: SalesDimension[] = ['by-product', 'by-category', 'by-branch', 'by-user', 'by-payment-method'];

export function SalesReportsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'summary' | SalesDimension | 'returns'>('summary');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('reports.sales.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('reports.sales.explainer')}</p>

      <ReportRangeControl from={from} to={to} onFrom={setFrom} onTo={setTo} testId="sales-range" />

      <Tabs
        data-testid="sales-report-tabs"
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
        tabs={[
          { id: 'summary', label: t('reports.sales.summary') },
          ...DIMENSIONS.map((d) => ({ id: d, label: t(`reports.sales.dimension.${d}`) })),
          { id: 'returns', label: t('reports.sales.returns') },
        ]}
      >
        {tab === 'summary' && <SummaryTab from={from} to={to} />}
        {DIMENSIONS.includes(tab as SalesDimension) && <DimensionTab dimension={tab as SalesDimension} from={from} to={to} />}
        {tab === 'returns' && <ReturnsTab from={from} to={to} />}
      </Tabs>
    </div>
  );
}

// ====================================================================
function SummaryTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['report-sales-summary', from, to],
    queryFn: () => reportsApi.salesSummary({ from: from || undefined, to: to || undefined }),
    placeholderData: keepPreviousData,
  });

  if (query.isLoading) return <Loading />;
  if (query.isError) return <ErrorBanner {...describeError(query.error)} />;
  const d = query.data!.data;

  return (
    <div>
      <RangeEcho range={query.data!.range} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" data-testid="sales-summary-figures">
        <Figure label={t('reports.sales.netSales')} value={formatMoney(d.netSales)} testId="figure-netSales" />
        <Figure label={t('reports.sales.subtotal')} value={formatMoney(d.subtotal)} />
        <Figure label={t('reports.sales.discounts')} value={formatMoney(d.discountAmount)} />
        <Figure label={t('reports.sales.tax')} value={formatMoney(d.taxAmount)} />
        <Figure label={t('reports.sales.total')} value={formatMoney(d.totalAmount)} testId="figure-totalAmount" />
        <Figure label={t('reports.sales.transactions')} value={String(d.transactionCount)} />
        <Figure label={t('reports.sales.averageInvoice')} value={formatMoney(d.averageInvoice)} />
        <Figure label={t('reports.sales.returnedQuantity')} value={d.returnedQuantity} />
        {/* Present ONLY because the response carried them. */}
        {hasCogs(d) && <Figure label={t('reports.sales.cogs')} value={formatMoney(d.cogs)} testId="figure-cogs" />}
        {hasGrossProfit(d) && (
          <Figure label={t('reports.sales.grossProfit')} value={formatMoney(d.grossProfit)} tone="good" testId="figure-grossProfit" />
        )}
      </div>
      <p className="mt-3 text-xs leading-snug text-neutral-500">{t('reports.sales.summaryBasis')}</p>
    </div>
  );
}

// ====================================================================
function DimensionTab({ dimension, from, to }: { dimension: SalesDimension; from: string; to: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [warehouseId, setWarehouseId] = useState('');
  const supportsWarehouse = dimensionSupportsWarehouse(dimension);

  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => inventoryApi.listWarehouses(),
    enabled: supportsWarehouse,
  });
  const query = useQuery({
    queryKey: ['report-sales-dimension', dimension, from, to, page, warehouseId],
    queryFn: () =>
      reportsApi.salesByDimension(dimension, {
        from: from || undefined,
        to: to || undefined,
        page,
        warehouseId: warehouseId || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const showCost = rowsCarryCost(rows);
  const showProfit = rowsCarryProfit(rows);
  const revenueOnly = dimensionHasOnlyRevenue(dimension);

  return (
    <div>
      {/* The warehouse filter appears ONLY where the server honours it.
          by-branch, by-user and by-payment-method accept the parameter
          and ignore it, so offering the control there would be a lie. */}
      {supportsWarehouse ? (
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Select
            label={t('inventory.warehouse')}
            value={warehouseId}
            onChange={(e) => {
              setWarehouseId(e.target.value);
              setPage(1);
            }}
            data-testid="dimension-warehouse"
          >
            <option value="">{t('inventory.allWarehouses')}</option>
            {(warehouses.data?.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <p className="mb-3 text-xs text-neutral-500" data-testid="no-warehouse-filter">
          {t('reports.sales.noWarehouseFilter')}
        </p>
      )}

      {revenueOnly && (
        <p className="mb-3 rounded-lg border border-warning-200 bg-warning-50 p-2 text-xs leading-snug text-warning-800" data-testid="revenue-only-note">
          {t('reports.sales.revenueOnly')}
        </p>
      )}

      <RangeEcho range={query.data?.range} />
      {query.isError && <ErrorBanner {...describeError(query.error)} />}

      <DataTable
        data-testid="dimension-table"
        loading={query.isLoading}
        rows={rows}
        rowKey={(r) => r.key}
        empty={t('reports.none')}
        columns={[
          { key: 'label', header: t('reports.sales.dimensionLabel'), cell: (r: DimensionRow) => r.label },
          ...(revenueOnly
            ? []
            : [{ key: 'qty', header: t('reports.sales.quantity'), align: 'end' as const, className: 'numeric', cell: (r: DimensionRow) => r.quantity }]),
          {
            key: 'net',
            header: t('reports.sales.netSales'),
            align: 'end' as const,
            className: 'numeric',
            cell: (r: DimensionRow) => formatMoney(r.netSales),
          },
          {
            key: 'transactions',
            header: t('reports.sales.transactions'),
            align: 'end' as const,
            className: 'numeric',
            cell: (r: DimensionRow) => String(r.transactionCount),
          },
          ...(showCost && !revenueOnly
            ? [
                {
                  key: 'cogs',
                  header: t('reports.sales.cogs'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (r: DimensionRow) => formatMoney(r.cogs),
                },
              ]
            : []),
          ...(showProfit && !revenueOnly
            ? [
                {
                  key: 'profit',
                  header: t('reports.sales.grossProfit'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (r: DimensionRow) => formatMoney(r.grossProfit),
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
        testId="dimension-pager"
      />
    </div>
  );
}

// ====================================================================
function ReturnsTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['report-sales-returns', from, to, page],
    queryFn: () => reportsApi.salesReturns({ from: from || undefined, to: to || undefined, page }),
    placeholderData: keepPreviousData,
  });

  if (query.isError) return <ErrorBanner {...describeError(query.error)} />;
  const summary = query.data?.summary;

  return (
    <div>
      <RangeEcho range={query.data?.range} />
      {summary && (
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="returns-summary">
          <Figure label={t('reports.sales.sellableValue')} value={formatMoney(summary.sellableValue)} />
          <Figure label={t('reports.sales.damagedValue')} value={formatMoney(summary.damagedValue)} tone="bad" />
          <Figure label={t('reports.sales.customerReturnValue')} value={formatMoney(summary.customerReturnValue)} />
          <Figure label={t('reports.sales.walkInReturnValue')} value={formatMoney(summary.walkInReturnValue)} />
        </div>
      )}

      <DataTable
        data-testid="returns-table"
        loading={query.isLoading}
        rows={query.data?.data ?? []}
        rowKey={(r) => r.id}
        empty={t('reports.none')}
        columns={[
          { key: 'number', header: t('reports.sales.returnNumber'), className: 'numeric', cell: (r: SalesReturnReportRow) => r.returnNumber },
          { key: 'sale', header: t('sales.saleNumber'), className: 'numeric', cell: (r) => r.saleNumber },
          {
            key: 'customer',
            header: t('sales.customer'),
            cell: (r) => (isWalkInReturn(r) ? <Badge tone="neutral">{t('sales.walkIn')}</Badge> : <Badge tone="brand">{t('reports.sales.onAccount')}</Badge>),
          },
          { key: 'lines', header: t('reports.sales.lines'), align: 'end', className: 'numeric', cell: (r) => String(r.items.length) },
          {
            key: 'value',
            header: t('reports.sales.returnValue'),
            align: 'end',
            className: 'numeric',
            cell: (r) => formatMoney(r.returnValue),
          },
          { key: 'when', header: t('sales.when'), cell: (r) => formatDateTime(r.createdAt) },
        ]}
      />
      <ReportPager
        page={query.data?.pagination.page ?? 1}
        totalPages={query.data?.pagination.totalPages ?? 1}
        total={query.data?.pagination.total ?? 0}
        onPage={setPage}
        testId="returns-pager"
      />
      {/* The server's own note about how returns hit the General Ledger. */}
      {summary && <Limitations limitations={{ glRevenueReversal: summary.glRevenueReversalNote }} testId="returns-limitations" />}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center p-8">
      <Spinner />
    </div>
  );
}
