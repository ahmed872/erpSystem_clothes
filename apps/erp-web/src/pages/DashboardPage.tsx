import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, CardBody, DataTable, ErrorBanner, Input, Spinner } from '@retail/ui-kit';
import { reportsApi } from '../api/reports';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import type { DashboardKpis, DashboardProductRow } from '../lib/apiTypes';

/**
 * Phase 13 (ERP slice) — the business at a glance, and nothing invented.
 *
 * EVERY FIGURE COMES FROM `GET /reports/dashboard`. Not one is computed,
 * combined or re-derived here: the server aggregates sales, reads the
 * general-ledger balances and resolves cost and profit, and this screen
 * formats strings. There is deliberately no "total" tile summing other
 * tiles — a dashboard number that disagreed with the ledger by a rounding
 * step would be worse than no number.
 *
 * COST AND PROFIT ARE ABSENT, NOT HIDDEN. The server DELETES `totalCost`,
 * `cogs` and `inventoryValue` for a caller without `products.view_cost`,
 * and `grossProfit`/`netProfit` without `reports.view_profit`. So the
 * tiles below render only what actually arrived — there is no client-side
 * permission branch that could be flipped to reveal a figure the response
 * never carried. A BRANCH_MANAGER holds neither grant and genuinely
 * receives neither key.
 *
 * THE SERVER'S OWN CAVEATS ARE PRINTED VERBATIM. `limitations` states, in
 * the backend's words, that `netProfit` excludes rent and salaries because
 * no expense module covers them. Paraphrasing that into reassuring UI copy
 * is how a dashboard starts lying.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = useQuery({
    queryKey: ['dashboard', from, to],
    queryFn: () => reportsApi.dashboard({ from: from || undefined, to: to || undefined }),
  });

  const kpis = query.data?.data.kpis;

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('dashboard.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('dashboard.explainer')}</p>

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 p-3">
          <Input
            label={t('dashboard.from')}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="dashboard-from"
          />
          <Input label={t('dashboard.to')} type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="dashboard-to" />
          <p className="mb-2 text-xs text-neutral-500">{t('dashboard.rangeHint')}</p>
        </CardBody>
      </Card>

      {query.isLoading && (
        <div className="flex justify-center p-8">
          <Spinner />
        </div>
      )}
      {query.isError && <ErrorBanner {...describeError(query.error)} />}

      {kpis && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" data-testid="dashboard-kpis">
            <Kpi label={t('dashboard.kpi.sales')} value={formatMoney(kpis.sales)} />
            <Kpi label={t('dashboard.kpi.netSales')} value={formatMoney(kpis.netSales)} />
            <Kpi label={t('dashboard.kpi.discounts')} value={formatMoney(kpis.discounts)} />
            <Kpi label={t('dashboard.kpi.transactions')} value={String(kpis.transactions)} />
            <Kpi label={t('dashboard.kpi.averageInvoice')} value={formatMoney(kpis.averageInvoice)} />
            <Kpi label={t('dashboard.kpi.receivables')} value={formatMoney(kpis.receivables)} />
            <Kpi label={t('dashboard.kpi.payables')} value={formatMoney(kpis.payables)} />
            <Kpi label={t('dashboard.kpi.cashBalance')} value={formatMoney(kpis.cashBalance)} />
            <Kpi label={t('dashboard.kpi.bankBalance')} value={formatMoney(kpis.bankBalance)} />

            {/* Rendered ONLY because the server sent them — i.e. only for a
                caller holding products.view_cost / reports.view_profit. */}
            {kpis.totalCost !== undefined && (
              <Kpi label={t('dashboard.kpi.totalCost')} value={formatMoney(kpis.totalCost)} testId="kpi-totalCost" />
            )}
            {kpis.cogs !== undefined && <Kpi label={t('dashboard.kpi.cogs')} value={formatMoney(kpis.cogs)} testId="kpi-cogs" />}
            {kpis.inventoryValue !== undefined && (
              <Kpi label={t('dashboard.kpi.inventoryValue')} value={formatMoney(kpis.inventoryValue)} testId="kpi-inventoryValue" />
            )}
            {kpis.grossProfit !== undefined && (
              <Kpi label={t('dashboard.kpi.grossProfit')} value={formatMoney(kpis.grossProfit)} testId="kpi-grossProfit" />
            )}
            {kpis.netProfit !== undefined && (
              <Kpi label={t('dashboard.kpi.netProfit')} value={formatMoney(kpis.netProfit)} testId="kpi-netProfit" />
            )}
          </div>

          <ProductTable
            title={t('dashboard.topProducts')}
            rows={query.data!.data.topProducts}
            empty={t('common.noResults')}
            testId="dashboard-top-products"
          />
          <ProductTable
            title={t('dashboard.slowestProducts')}
            rows={query.data!.data.slowestProducts}
            empty={t('common.noResults')}
            testId="dashboard-slow-products"
          />

          {/* The backend's own statement of what these figures exclude. */}
          <div className="mt-4 rounded-xl border border-warning-200 bg-warning-50 p-3">
            <p className="mb-1 text-xs font-semibold text-neutral-800">{t('dashboard.limitationsTitle')}</p>
            <ul className="flex list-disc flex-col gap-1 ps-4 text-[11px] leading-snug text-neutral-600">
              {Object.entries(query.data!.limitations).map(([key, text]) => (
                <li key={key} data-testid={`limitation-${key}`}>
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <Card>
      <CardBody className="p-3">
        <p className="text-xs text-neutral-500">{label}</p>
        <p className="numeric mt-1 text-lg font-bold text-neutral-900" data-testid={testId}>
          {value}
        </p>
      </CardBody>
    </Card>
  );
}

function ProductTable({
  title,
  rows,
  empty,
  testId,
}: {
  title: string;
  rows: DashboardProductRow[];
  empty: string;
  testId: string;
}) {
  const { t } = useTranslation();
  // Profit/margin columns appear only when the SERVER sent those fields on
  // the rows — same rule as the KPI tiles, applied per column.
  const showsProfit = rows.some((r) => r.profit !== undefined);

  return (
    <div className="mt-4">
      <h2 className="mb-2 text-sm font-bold text-neutral-900">{title}</h2>
      <DataTable
        data-testid={testId}
        rows={rows}
        rowKey={(r) => r.variantId}
        empty={empty}
        columns={[
          { key: 'name', header: t('dashboard.product'), cell: (r) => r.name },
          { key: 'sku', header: t('dashboard.sku'), cell: (r) => r.sku, className: 'numeric' },
          { key: 'qty', header: t('dashboard.quantity'), align: 'end', className: 'numeric', cell: (r) => r.quantity },
          { key: 'revenue', header: t('dashboard.revenue'), align: 'end', className: 'numeric', cell: (r) => formatMoney(r.revenue) },
          ...(showsProfit
            ? [
                {
                  key: 'profit',
                  header: t('dashboard.profit'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (r: DashboardProductRow) => (r.profit === undefined ? '—' : formatMoney(r.profit)),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

export type { DashboardKpis };
