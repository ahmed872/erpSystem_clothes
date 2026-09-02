import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge, DataTable, ErrorBanner, Input, Spinner, Tabs } from '@retail/ui-kit';
import { reportsApi } from '../api/reports';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDate, formatDateTime } from '../lib/datetime';
import { hasOutstanding, isBalanced, ledgerSide } from '../lib/reports';
import { Figure, Limitations, RangeEcho, ReportPager, ReportRangeControl } from '../components/ReportControls';
import type { BalanceSheetAccount, GeneralLedgerRow, PartyBalanceRow } from '../lib/apiTypes';

/**
 * Phase 19 — FINANCIAL REPORTS.
 *
 * THE OWNER DECISION THIS SCREEN IS BUILT ON. `reports.financial.view`
 * IMPLIES visibility of these reports' own contents, profit lines
 * included: a Profit & Loss without `grossProfit` is a document with its
 * purpose removed, and the General Ledger under the same grant already
 * exposes the COGS journal lines from which profit is derivable. So this
 * screen renders `costOfGoodsSold`, `grossProfit`, `netProfit` and
 * `currentPeriodEarnings` unconditionally, and checks NO permission of
 * its own — the route guard and the backend guard are the boundary.
 *
 * That decision is scoped to this family alone. Everywhere else the
 * server still deletes cost and profit keys and those screens ask whether
 * the payload carried them.
 *
 * FOUR DIFFERENT PARAMETER CONTRACTS, so four different control sets:
 *   - P&L takes from/to. It also ACCEPTS `branchId` and ignores it (the
 *     GL has no branch dimension), so no branch picker is offered.
 *   - BALANCE SHEET takes a single `asAt` instant — not a range.
 *   - GENERAL LEDGER takes from/to plus paging.
 *   - RECEIVABLES and PAYABLES take paging only; they are as-at-now
 *     positions with no range and no branch scope at all.
 *
 * NOTHING IS RECOMPUTED. Even the balance sheet's equation check is the
 * server's own `balanced` flag rather than a comparison made here.
 */
export function FinancialReportsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'pl' | 'balance' | 'ledger' | 'receivables' | 'payables'>('pl');

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('reports.financial.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('reports.financial.explainer')}</p>

      <Tabs
        data-testid="financial-report-tabs"
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
        tabs={[
          { id: 'pl', label: t('reports.financial.profitAndLoss') },
          { id: 'balance', label: t('reports.financial.balanceSheet') },
          { id: 'ledger', label: t('reports.financial.generalLedger') },
          { id: 'receivables', label: t('reports.financial.receivables') },
          { id: 'payables', label: t('reports.financial.payables') },
        ]}
      >
        {tab === 'pl' && <ProfitAndLossTab />}
        {tab === 'balance' && <BalanceSheetTab />}
        {tab === 'ledger' && <GeneralLedgerTab />}
        {tab === 'receivables' && <PartyBalancesTab kind="receivables" />}
        {tab === 'payables' && <PartyBalancesTab kind="payables" />}
      </Tabs>
    </div>
  );
}

// ====================================================================
function ProfitAndLossTab() {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = useQuery({
    queryKey: ['report-pl', from, to],
    queryFn: () => reportsApi.profitAndLoss({ from: from || undefined, to: to || undefined }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <ReportRangeControl from={from} to={to} onFrom={setFrom} onTo={setTo} hint={t('reports.financial.businessWide')} testId="pl-range" />
      {query.isLoading && <Loading />}
      {query.isError && <ErrorBanner {...describeError(query.error)} />}
      {query.data && (
        <>
          <RangeEcho range={query.data.range} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="pl-figures">
            <Figure label={t('reports.financial.netRevenue')} value={formatMoney(query.data.data.netRevenue)} testId="figure-netRevenue" />
            <Figure label={t('reports.financial.cogs')} value={formatMoney(query.data.data.costOfGoodsSold)} testId="figure-costOfGoodsSold" />
            <Figure
              label={t('reports.financial.grossProfit')}
              value={formatMoney(query.data.data.grossProfit)}
              tone="good"
              testId="figure-grossProfit"
            />
            <Figure
              label={t('reports.financial.shrinkage')}
              value={formatMoney(query.data.data.inventoryRelatedOperatingExpenses.inventoryShrinkage)}
            />
            <Figure
              label={t('reports.financial.internalConsumption')}
              value={formatMoney(query.data.data.inventoryRelatedOperatingExpenses.internalConsumption)}
            />
            <Figure
              label={t('reports.financial.operatingExpenses')}
              value={formatMoney(query.data.data.inventoryRelatedOperatingExpenses.total)}
              tone="bad"
            />
            <Figure label={t('reports.financial.otherIncome')} value={formatMoney(query.data.data.otherIncome)} />
            <Figure label={t('reports.financial.netProfit')} value={formatMoney(query.data.data.netProfit)} tone="good" testId="figure-netProfit" />
          </div>
          {/* The server's own caveats about what these figures do NOT
              include — printed verbatim, never paraphrased. */}
          <Limitations limitations={query.data.limitations} testId="pl-limitations" />
        </>
      )}
    </div>
  );
}

// ====================================================================
function BalanceSheetTab() {
  const { t } = useTranslation();
  const [asAt, setAsAt] = useState('');
  const query = useQuery({
    queryKey: ['report-balance-sheet', asAt],
    queryFn: () => reportsApi.balanceSheet({ asAt: asAt || undefined }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      {/* `asAt` — a single instant. There is deliberately no from/to here:
          a balance sheet is a position, not a period. */}
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Input label={t('reports.financial.asAt')} type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} data-testid="balance-asat" />
      </div>
      {query.isLoading && <Loading />}
      {query.isError && <ErrorBanner {...describeError(query.error)} />}
      {query.data && (
        <>
          <p className="mb-3 text-xs text-neutral-500" data-testid="balance-asat-echo">
            {t('reports.financial.asAtEcho', { date: formatDateTime(query.data.data.asAt) })}
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            {/* The SERVER's equation check, not a comparison made here. */}
            <Badge tone={isBalanced(query.data) ? 'success' : 'danger'} data-testid="balance-flag">
              {t(isBalanced(query.data) ? 'reports.financial.balanced' : 'reports.financial.notBalanced')}
            </Badge>
            <Figure label={t('reports.financial.assets')} value={formatMoney(query.data.data.assets.total)} testId="figure-assets" />
            <Figure label={t('reports.financial.liabilities')} value={formatMoney(query.data.data.liabilities.total)} />
            <Figure label={t('reports.financial.equity')} value={formatMoney(query.data.data.equity.total)} />
            <Figure
              label={t('reports.financial.currentPeriodEarnings')}
              value={formatMoney(query.data.data.equity.currentPeriodEarnings)}
              testId="figure-currentPeriodEarnings"
            />
          </div>

          <AccountSection title={t('reports.financial.assets')} accounts={query.data.data.assets.accounts} testId="assets-table" />
          <AccountSection title={t('reports.financial.liabilities')} accounts={query.data.data.liabilities.accounts} testId="liabilities-table" />
          <AccountSection title={t('reports.financial.equity')} accounts={query.data.data.equity.accounts} testId="equity-table" />

          <Limitations limitations={query.data.limitations} testId="balance-limitations" />
        </>
      )}
    </div>
  );
}

function AccountSection({ title, accounts, testId }: { title: string; accounts: BalanceSheetAccount[]; testId: string }) {
  const { t } = useTranslation();
  return (
    <div className="mb-4">
      <h2 className="mb-2 text-sm font-bold text-neutral-900">{title}</h2>
      <DataTable
        data-testid={testId}
        rows={accounts}
        rowKey={(a) => a.accountId}
        empty={t('reports.none')}
        columns={[
          { key: 'code', header: t('reports.financial.accountCode'), className: 'numeric', cell: (a: BalanceSheetAccount) => a.code },
          { key: 'name', header: t('reports.financial.accountName'), cell: (a) => a.name },
          { key: 'balance', header: t('reports.financial.balance'), align: 'end', className: 'numeric', cell: (a) => formatMoney(a.balance) },
        ]}
      />
    </div>
  );
}

// ====================================================================
function GeneralLedgerTab() {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['report-gl', from, to, page],
    queryFn: () => reportsApi.generalLedger({ from: from || undefined, to: to || undefined, page }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <ReportRangeControl from={from} to={to} onFrom={setFrom} onTo={setTo} hint={t('reports.financial.businessWide')} testId="gl-range" />
      <RangeEcho range={query.data?.range} />
      {query.isError && <ErrorBanner {...describeError(query.error)} />}
      <DataTable
        data-testid="gl-table"
        loading={query.isLoading}
        rows={query.data?.data ?? []}
        rowKey={(r) => `${r.journalEntryId}:${r.accountId}:${r.debit}:${r.credit}`}
        empty={t('reports.none')}
        columns={[
          { key: 'entry', header: t('reports.financial.entryNumber'), className: 'numeric', cell: (r: GeneralLedgerRow) => r.entryNumber },
          { key: 'date', header: t('sales.when'), cell: (r) => formatDate(r.entryDate) },
          { key: 'account', header: t('reports.financial.account'), cell: (r) => `${r.accountCode} · ${r.accountName}` },
          { key: 'source', header: t('reports.financial.source'), cell: (r) => r.sourceType },
          {
            key: 'debit',
            header: t('reports.financial.debit'),
            align: 'end',
            className: 'numeric',
            cell: (r) => (ledgerSide(r) === 'debit' ? formatMoney(r.debit) : '—'),
          },
          {
            key: 'credit',
            header: t('reports.financial.credit'),
            align: 'end',
            className: 'numeric',
            cell: (r) => (ledgerSide(r) === 'credit' ? formatMoney(r.credit) : '—'),
          },
        ]}
      />
      <ReportPager
        page={query.data?.pagination.page ?? 1}
        totalPages={query.data?.pagination.totalPages ?? 1}
        total={query.data?.pagination.total ?? 0}
        onPage={setPage}
        testId="gl-pager"
      />
    </div>
  );
}

// ====================================================================
function PartyBalancesTab({ kind }: { kind: 'receivables' | 'payables' }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['report-party', kind, page],
    queryFn: () => (kind === 'receivables' ? reportsApi.receivables({ page }) : reportsApi.payables({ page })),
    placeholderData: keepPreviousData,
  });

  const summary = query.data?.summary;
  const total = summary?.totalReceivable ?? summary?.totalPayable;

  return (
    <div>
      {/* No range and no branch: these are as-at-now positions, and the
          contract accepts page/limit only. */}
      <p className="mb-3 text-xs text-neutral-500" data-testid={`${kind}-no-range`}>
        {t('reports.financial.positionNow')}
      </p>
      {query.isError && <ErrorBanner {...describeError(query.error)} />}

      {total !== undefined && (
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3" data-testid={`${kind}-summary`}>
          <Figure label={t(`reports.financial.${kind}Total`)} value={formatMoney(total)} testId={`figure-${kind}Total`} />
          <Figure
            label={t('reports.financial.partyCount')}
            value={String(summary?.customerCount ?? summary?.supplierCount ?? query.data?.pagination.total ?? 0)}
          />
        </div>
      )}

      <DataTable
        data-testid={`${kind}-table`}
        loading={query.isLoading}
        rows={query.data?.data ?? []}
        rowKey={(r) => r.id}
        empty={t('reports.none')}
        columns={[
          { key: 'name', header: t('reports.financial.party'), cell: (r: PartyBalanceRow) => r.name },
          {
            key: 'balance',
            header: t('reports.financial.balance'),
            align: 'end',
            className: 'numeric',
            cell: (r) => <span className={hasOutstanding(r) ? 'font-bold text-warning-700' : ''}>{formatMoney(r.balance)}</span>,
          },
        ]}
      />
      <ReportPager
        page={query.data?.pagination.page ?? 1}
        totalPages={query.data?.pagination.totalPages ?? 1}
        total={query.data?.pagination.total ?? 0}
        onPage={setPage}
        testId={`${kind}-pager`}
      />
      <Limitations limitations={query.data?.limitations} testId={`${kind}-limitations`} />
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
