import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ErrorBanner, Spinner } from '@retail/ui-kit';
import { reportsApi } from '../api/reports';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { Figure, RangeEcho, ReportRangeControl } from '../components/ReportControls';

/**
 * Phase 19 — PURCHASING REPORT.
 *
 * One endpoint, one window, one set of server-computed figures.
 *
 * IT SITS UNDER `reports.sales.view`, NOT `purchases.view`. That is the
 * live contract, not a choice made here: the route is
 * `GET /reports/purchasing/summary` on the sales-reports controller. So
 * the screen is reachable by exactly the callers who can read the sales
 * reports, and the nav entry asks for the same grant.
 *
 * THE THREE COST FIGURES ARE OPTIONAL. `totalCost`, `returnedCost` and
 * `netPurchaseCost` are deleted by the server for a caller without
 * `products.view_cost`, so they render only when the response carried
 * them — the operational counts and quantities always do.
 */
export function PurchasingReportPage() {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = useQuery({
    queryKey: ['report-purchasing', from, to],
    queryFn: () => reportsApi.purchasingSummary({ from: from || undefined, to: to || undefined }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="mx-auto max-w-5xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('reports.purchasing.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('reports.purchasing.explainer')}</p>

      <ReportRangeControl from={from} to={to} onFrom={setFrom} onTo={setTo} testId="purchasing-range" />

      {query.isLoading && (
        <div className="flex justify-center p-8">
          <Spinner />
        </div>
      )}
      {query.isError && <ErrorBanner {...describeError(query.error)} />}

      {query.data && (
        <>
          <RangeEcho range={query.data.range} />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="purchasing-figures">
            <Figure label={t('reports.purchasing.receiptCount')} value={String(query.data.data.receiptCount)} testId="figure-receiptCount" />
            <Figure label={t('reports.purchasing.receivedQuantity')} value={query.data.data.receivedQuantity} />
            <Figure label={t('reports.purchasing.returnCount')} value={String(query.data.data.returnCount)} />
            <Figure label={t('reports.purchasing.returnedQuantity')} value={query.data.data.returnedQuantity} />
            <Figure label={t('reports.purchasing.paidToSuppliers')} value={formatMoney(query.data.data.paidToSuppliers)} />
            {/* Rendered only because the response carried them. */}
            {query.data.data.totalCost !== undefined && (
              <Figure label={t('reports.purchasing.totalCost')} value={formatMoney(query.data.data.totalCost)} testId="figure-totalCost" />
            )}
            {query.data.data.returnedCost !== undefined && (
              <Figure label={t('reports.purchasing.returnedCost')} value={formatMoney(query.data.data.returnedCost)} />
            )}
            {query.data.data.netPurchaseCost !== undefined && (
              <Figure
                label={t('reports.purchasing.netPurchaseCost')}
                value={formatMoney(query.data.data.netPurchaseCost)}
                testId="figure-netPurchaseCost"
              />
            )}
          </div>
          <p className="mt-3 text-xs leading-snug text-neutral-500">{t('reports.purchasing.basis')}</p>
        </>
      )}
    </div>
  );
}
