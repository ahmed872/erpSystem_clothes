import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge, Card, CardBody, DataTable, ErrorBanner, Tabs } from '@retail/ui-kit';
import { reportsApi } from '../api/reports';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { isReconciled } from '../lib/reports';
import { ReportPager } from '../components/ReportControls';
import { usePermission } from '../hooks/usePermission';
import type { ReconciliationExclusion } from '../lib/apiTypes';

/**
 * Phase 19 — RECONCILIATION.
 *
 * Four reports that each compare TWO sources the system maintains
 * independently and state whether they agree. They are the closest thing
 * the product has to an audit, so the screen reports what the server
 * concluded and computes nothing: `reconciled` and `discrepancyCount` are
 * the server's own verdict, and re-deriving them here would be a second
 * reconciliation engine free to disagree with the one that matters.
 *
 * TWO DIFFERENT GRANTS BEHIND ONE SCREEN. The inventory ledger is
 * `reports.inventory.view`; customer AR, supplier AP and the inventory GL
 * are `reports.financial.view`. A BRANCH_MANAGER holds the first and none
 * of the others, so each TAB is offered only to a caller who holds its
 * own grant — and the backend refuses the others regardless.
 *
 * THE EXCLUSIONS ARE THE POINT. Each report names, in the server's own
 * words, exactly which movements it left out and why; a reconciliation
 * that silently excluded rows would prove nothing. They are printed
 * verbatim.
 */
export function ReconciliationPage() {
  const { t } = useTranslation();
  const canInventory = usePermission('reports.inventory.view');
  const canFinancial = usePermission('reports.financial.view');

  const tabs = [
    ...(canInventory ? [{ id: 'inventory-ledger', label: t('reports.recon.inventoryLedger') }] : []),
    ...(canFinancial
      ? [
          { id: 'customer-ar', label: t('reports.recon.customerAr') },
          { id: 'supplier-ap', label: t('reports.recon.supplierAp') },
          { id: 'inventory-gl', label: t('reports.recon.inventoryGl') },
        ]
      : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.id ?? '');

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('reports.recon.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('reports.recon.explainer')}</p>

      <Tabs data-testid="recon-tabs" active={tab} onChange={setTab} tabs={tabs}>
        {tab === 'inventory-ledger' && <ReconTab kind="inventory-ledger" />}
        {tab === 'customer-ar' && <ReconTab kind="customer-ar" />}
        {tab === 'supplier-ap' && <ReconTab kind="supplier-ap" />}
        {tab === 'inventory-gl' && <ReconTab kind="inventory-gl" />}
      </Tabs>
    </div>
  );
}

type ReconKind = 'inventory-ledger' | 'customer-ar' | 'supplier-ap' | 'inventory-gl';

function ReconTab({ kind }: { kind: ReconKind }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['report-recon', kind, page],
    queryFn: () =>
      kind === 'inventory-ledger'
        ? reportsApi.reconInventoryLedger({ page })
        : kind === 'customer-ar'
          ? reportsApi.reconCustomerAr({ page })
          : kind === 'supplier-ap'
            ? reportsApi.reconSupplierAp({ page })
            : reportsApi.reconInventoryGl({ page }),
    placeholderData: keepPreviousData,
  });

  if (query.isError) return <ErrorBanner {...describeError(query.error)} />;
  const result = query.data;
  const verdict = result ? isReconciled(result) : null;
  const rows = result?.data ?? [];
  // The row shape differs per report, so the columns are derived from the
  // keys the server actually sent rather than hardcoded five times.
  const columnKeys = Object.keys(rows[0] ?? {});

  return (
    <div>
      {result && (
        <Card className="mb-3">
          <CardBody className="p-4" data-testid={`recon-summary-${kind}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {verdict !== null && (
                <Badge tone={verdict ? 'success' : 'danger'} data-testid={`recon-verdict-${kind}`}>
                  {t(verdict ? 'reports.recon.reconciled' : 'reports.recon.discrepancies')}
                </Badge>
              )}
              {typeof result.summary.discrepancyCount === 'number' && (
                <span className="numeric text-xs text-neutral-500" data-testid={`recon-count-${kind}`}>
                  {t('reports.recon.discrepancyCount', { count: result.summary.discrepancyCount })}
                </span>
              )}
            </div>
            <Source label={t('reports.recon.sourceA')} value={result.summary.sourceA} />
            <Source label={t('reports.recon.sourceB')} value={result.summary.sourceB} />
            <Source label={t('reports.recon.expected')} value={result.summary.expectedRelationship} />
          </CardBody>
        </Card>
      )}

      {(result?.summary.exclusions?.length ?? 0) > 0 && (
        <div className="mb-3 rounded-lg border border-warning-200 bg-warning-50 p-3" data-testid={`recon-exclusions-${kind}`}>
          <p className="mb-1 text-xs font-bold text-warning-800">{t('reports.recon.exclusions')}</p>
          <ul className="space-y-2">
            {result!.summary.exclusions!.map((e: ReconciliationExclusion, i) => (
              <li key={i} className="text-xs leading-snug text-warning-800">
                <span className="numeric font-semibold">{e.movementType}</span>
                {e.excludedValue !== undefined && <span className="numeric ms-2">{formatMoney(e.excludedValue)}</span>}
                {e.excludedMovementCount !== undefined && (
                  <span className="numeric ms-2">({t('reports.recon.movements', { count: e.excludedMovementCount })})</span>
                )}
                <span className="ms-1">— {e.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <DataTable
        data-testid={`recon-table-${kind}`}
        loading={query.isLoading}
        rows={rows}
        // A discrepancy row has no id of its own — the server sends
        // whatever identifies the mismatch — so the row itself is the key.
        rowKey={(r) => JSON.stringify(r)}
        empty={t('reports.recon.noDiscrepancies')}
        columns={columnKeys.map((k) => ({
          key: k,
          header: k,
          className: 'numeric',
          cell: (r: Record<string, unknown>) => renderCell(r[k]),
        }))}
      />
      <ReportPager
        page={result?.pagination.page ?? 1}
        totalPages={result?.pagination.totalPages ?? 1}
        total={result?.pagination.total ?? 0}
        onPage={setPage}
        testId={`recon-pager-${kind}`}
      />
    </div>
  );
}

/** A discrepancy row is whatever the server chose to send; render it
 *  without interpreting it. */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function Source({ label, value }: { label: string; value: string }) {
  return (
    <p className="mb-1 text-xs leading-snug text-neutral-600">
      <span className="font-semibold text-neutral-800">{label}: </span>
      {value}
    </p>
  );
}
