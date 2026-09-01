import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
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
  SpinnerOverlay,
} from '@retail/ui-kit';
import { customersApi } from '../api/customers';
import { salesApi } from '../api/sales';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDateTime } from '../lib/datetime';
import {
  CUSTOMER_TRANSACTION_CAP,
  canDeactivateCustomer,
  customerTone,
  hasLoyaltyHistory,
  inCredit,
  ledgerMayBeTruncated,
  owesBusiness,
  pointsAdded,
  pointsTone,
  transactionTone,
} from '../lib/customers';
import { saleTone } from '../lib/sales';
import { usePermission } from '../hooks/usePermission';
import { CustomerDialog } from './CustomersPage';
import type { CustomerPointsRow, CustomerPointsType, CustomerTransactionRow, SaleListRow } from '../lib/apiTypes';

/**
 * Phase 18 — ONE CUSTOMER.
 *
 * THREE GRANTS, THREE INDEPENDENT PANELS. The account is
 * `customers.view`; loyalty is `loyalty.view`; sales history is
 * `sales.view`. A BRANCH_MANAGER holds all three, an ACCOUNTANT holds all
 * three plus `loyalty.adjust`, and a custom role may hold only the first.
 * So each panel is its own query and renders only if its grant is held —
 * one composite request would 403 as a whole and show a customer nothing
 * about a customer.
 *
 * NOTHING IS ADDED UP HERE. The account balance and the points balance
 * are both server-derived sums over ledgers the browser cannot see in
 * full; a lifetime-spend figure is NOT shown, because no endpoint returns
 * one and summing a page of sales would be wrong on the second page.
 */
export function CustomerDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { customerId = '' } = useParams();
  const queryClient = useQueryClient();
  const canEdit = usePermission('customers.edit');
  const canDeactivate = usePermission('customers.delete');
  const canViewLoyalty = usePermission('loyalty.view');
  const canAdjustLoyalty = usePermission('loyalty.adjust');
  const canViewSales = usePermission('sales.view');

  const [editing, setEditing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const customer = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => customersApi.get(customerId),
  });

  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }
  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
  }

  const deactivate = useMutation({
    mutationFn: () => customersApi.deactivate(customerId),
    onSuccess: async () => {
      setDeactivating(false);
      await refresh(t('customers.deactivated'));
    },
    onError: (e) => {
      setDeactivating(false);
      fail(e);
    },
  });

  if (customer.isLoading) return <SpinnerOverlay />;
  if (customer.isError) {
    return (
      <div className="mx-auto max-w-5xl p-4">
        <ErrorBanner {...describeError(customer.error)} />
        <Button variant="ghost" size="sm" onClick={() => navigate('/customers')}>
          {t('customers.backToList')}
        </Button>
      </div>
    );
  }
  const c = customer.data!.data;

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold text-neutral-900" data-testid="customer-name-heading">
              {c.name}
            </h1>
            <Badge tone={customerTone(c)} data-testid="customer-state-badge">
              {t(c.isActive ? 'customers.activeLabel' : 'customers.inactiveLabel')}
            </Badge>
          </div>
          <p className="text-xs text-neutral-500">
            {t('customers.since', { date: formatDateTime(c.createdAt) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} data-testid="edit-customer">
              {t('common.edit')}
            </Button>
          )}
          {canDeactivate && canDeactivateCustomer(c) && (
            <Button variant="ghost" size="sm" onClick={() => setDeactivating(true)} data-testid="deactivate-customer">
              {t('customers.deactivate')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => navigate('/customers')}>
            {t('customers.backToList')}
          </Button>
        </div>
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="customer-result">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}

      {/* Identity, exactly the fields the contract stores. */}
      <Card className="mb-4">
        <CardBody className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 sm:grid-cols-2">
          <Field label={t('customers.phone')} value={c.phone} numeric testId="customer-phone-value" />
          <Field label={t('customers.email')} value={c.email} testId="customer-email-value" />
          <Field label={t('customers.address')} value={c.address} />
          <Field label={t('customers.taxNumber')} value={c.taxNumber} numeric />
        </CardBody>
      </Card>

      {/* The one financial figure, and it is the server's. */}
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-xs text-neutral-500">{t('customers.balance')}</p>
            <p
              className={`numeric mt-1 text-xl font-bold ${
                owesBusiness(c) ? 'text-warning-700' : inCredit(c) ? 'text-success-700' : 'text-neutral-900'
              }`}
              data-testid="customer-balance"
            >
              {formatMoney(c.balance)}
            </p>
          </div>
          <p className="max-w-md text-xs leading-snug text-neutral-500">
            {owesBusiness(c) ? t('customers.owesHint') : inCredit(c) ? t('customers.creditHint') : t('customers.settledHint')}
          </p>
        </CardBody>
      </Card>

      <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('customers.account')}</h2>
      <DataTable
        data-testid="customer-transactions"
        rows={c.recentTransactions}
        rowKey={(r) => r.id}
        empty={t('customers.noTransactions')}
        columns={[
          {
            key: 'type',
            header: t('customers.transactionType'),
            cell: (r: CustomerTransactionRow) => (
              <Badge tone={transactionTone(r.type)}>{t(`customers.transactionLabel.${r.type}`)}</Badge>
            ),
          },
          {
            key: 'amount',
            header: t('customers.amount'),
            align: 'end',
            className: 'numeric',
            // The SIGNED figure the ledger stored, coloured by comparison.
            cell: (r) => <span className={Number(r.amount) > 0 ? 'text-warning-700' : 'text-success-700'}>{formatMoney(r.amount)}</span>,
          },
          { key: 'description', header: t('customers.description'), cell: (r) => r.description ?? '—' },
          { key: 'when', header: t('customers.when'), cell: (r) => formatDateTime(r.createdAt) },
        ]}
      />
      {ledgerMayBeTruncated(c) && (
        <p className="mt-1 text-xs text-neutral-500" data-testid="transactions-capped">
          {t('customers.transactionsCapped', { cap: CUSTOMER_TRANSACTION_CAP })}
        </p>
      )}

      {canViewLoyalty && <LoyaltyPanel customerId={customerId} canAdjust={canAdjustLoyalty} onError={fail} onDone={refresh} />}
      {canViewSales && <SalesHistoryPanel customerId={customerId} />}

      {editing && (
        <CustomerDialog
          customer={c}
          onClose={() => setEditing(false)}
          onError={fail}
          onSaved={async () => {
            setEditing(false);
            await refresh(t('customers.updated'));
          }}
        />
      )}

      <ConfirmDialog
        open={deactivating}
        tone="danger"
        title={t('customers.deactivateTitle')}
        message={t('customers.deactivateWarning')}
        confirmLabel={t('customers.deactivate')}
        cancelLabel={t('common.cancel')}
        pending={deactivate.isPending}
        onConfirm={() => deactivate.mutate()}
        onClose={() => setDeactivating(false)}
        data-testid="deactivate-customer-dialog"
      />
    </div>
  );
}

// ====================================================================
/**
 * Loyalty, behind `loyalty.view`. The balance shown is the one the server
 * returns with the page — deliberately NOT a sum of the rows on screen,
 * which would be this page's subtotal rather than the customer's balance,
 * and would change when the type filter changes.
 */
function LoyaltyPanel({
  customerId,
  canAdjust,
  onError,
  onDone,
}: {
  customerId: string;
  canAdjust: boolean;
  onError: (e: unknown) => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [type, setType] = useState<'' | CustomerPointsType>('');
  const [page, setPage] = useState(1);
  const [adjusting, setAdjusting] = useState(false);

  const balance = useQuery({
    queryKey: ['customer-points', customerId],
    queryFn: () => customersApi.points(customerId),
  });
  const ledger = useQuery({
    queryKey: ['customer-points-ledger', customerId, type, page],
    queryFn: () => customersApi.pointsLedger(customerId, { type: type || undefined, page }),
    placeholderData: keepPreviousData,
  });

  const summary = balance.data?.data;
  const pagination = ledger.data?.pagination;

  return (
    <div className="mt-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-neutral-900">{t('customers.loyalty')}</h2>
        {canAdjust && (
          <Button size="sm" variant="secondary" onClick={() => setAdjusting(true)} data-testid="adjust-points">
            {t('customers.adjustPoints')}
          </Button>
        )}
      </div>

      {balance.isError && <ErrorBanner {...describeError(balance.error)} />}

      <Card className="mb-3">
        <CardBody className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-xs text-neutral-500">{t('customers.pointsBalance')}</p>
            <p className="numeric mt-1 text-xl font-bold text-neutral-900" data-testid="points-balance">
              {summary?.balance ?? '—'}
            </p>
          </div>
          <p className="max-w-md text-xs leading-snug text-neutral-500">
            {summary && hasLoyaltyHistory(summary)
              ? t('customers.pointsDerivation', { count: summary.eventCount })
              : t('customers.noPointsYet')}
          </p>
        </CardBody>
      </Card>

      <div className="mb-2 flex flex-wrap items-end gap-3">
        <Select
          label={t('customers.pointsType')}
          value={type}
          onChange={(e) => {
            setType(e.target.value as '' | CustomerPointsType);
            setPage(1);
          }}
          data-testid="points-type"
        >
          <option value="">{t('customers.allPointTypes')}</option>
          {(['EARN', 'REDEEM', 'RETURN_CLAWBACK', 'ADJUSTMENT'] as CustomerPointsType[]).map((x) => (
            <option key={x} value={x}>
              {t(`customers.pointsLabel.${x}`)}
            </option>
          ))}
        </Select>
      </div>

      <DataTable
        data-testid="points-ledger"
        loading={ledger.isLoading}
        rows={ledger.data?.data ?? []}
        rowKey={(r) => r.id}
        empty={t('customers.noPoints')}
        columns={[
          {
            key: 'type',
            header: t('customers.pointsType'),
            cell: (r: CustomerPointsRow) => <Badge tone={pointsTone(r.type)}>{t(`customers.pointsLabel.${r.type}`)}</Badge>,
          },
          {
            key: 'points',
            header: t('customers.points'),
            align: 'end',
            className: 'numeric',
            cell: (r) => <span className={pointsAdded(r) ? 'text-success-700' : 'text-warning-700'}>{r.points}</span>,
          },
          {
            key: 'basis',
            header: t('customers.basis'),
            align: 'end',
            className: 'numeric',
            // The merchandise amount the points were computed from, as
            // snapshotted at the time. Not recomputed from anything.
            cell: (r) => (r.basisAmount === null ? '—' : formatMoney(r.basisAmount)),
          },
          { key: 'description', header: t('customers.description'), cell: (r) => r.description ?? '—' },
          { key: 'when', header: t('customers.when'), cell: (r) => formatDateTime(r.createdAt) },
        ]}
      />

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2" data-testid="points-pagination">
          <p className="text-xs text-neutral-500">
            {t('customers.pointsPageOf', { page: pagination.page, totalPages: pagination.totalPages, total: pagination.total })}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={pagination.page <= 1} onClick={() => setPage(pagination.page - 1)}>
              {t('catalogue.previous')}
            </Button>
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

      {adjusting && (
        <AdjustPointsDialog
          customerId={customerId}
          onClose={() => setAdjusting(false)}
          onError={onError}
          onSaved={async () => {
            setAdjusting(false);
            await queryClient.invalidateQueries({ queryKey: ['customer-points', customerId] });
            await queryClient.invalidateQueries({ queryKey: ['customer-points-ledger', customerId] });
            await onDone(t('customers.pointsAdjusted'));
          }}
        />
      )}
    </div>
  );
}

// ====================================================================
/**
 * The one human-entered write to the points ledger. A reason is REQUIRED
 * by the schema, the figure is SIGNED (a negative removes points), and the
 * key is minted per dialog so a double submit adjusts once.
 */
function AdjustPointsDialog({
  customerId,
  onClose,
  onSaved,
  onError,
}: {
  customerId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const save = useMutation({
    mutationFn: () => customersApi.adjustPoints(customerId, { points: Number(points), reason: reason.trim(), idempotencyKey }),
    onSuccess: onSaved,
    onError,
  });

  return (
    <ConfirmDialog
      open
      title={t('customers.adjustPoints')}
      message={t('customers.adjustPointsWarning')}
      confirmLabel={t('customers.adjustPoints')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="adjust-points-dialog"
    >
      <Input
        label={t('customers.points')}
        type="number"
        step="any"
        value={points}
        onChange={(e) => setPoints(e.target.value)}
        data-testid="adjust-points-value"
      />
      <Input
        label={t('customers.reason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        data-testid="adjust-points-reason"
      />
    </ConfirmDialog>
  );
}

// ====================================================================
/**
 * Sales history, behind `sales.view` — the SAME `GET /sales?customerId=`
 * the sales list uses, paginated by the server.
 *
 * There is deliberately NO lifetime-spend or order-count figure: no
 * endpoint returns one, and adding up the rows on this page would be a
 * number that is wrong as soon as there is a second page.
 */
function SalesHistoryPanel({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  const sales = useQuery({
    queryKey: ['customer-sales', customerId, page],
    queryFn: () => salesApi.list({ customerId, page, limit: 10 }),
    placeholderData: keepPreviousData,
  });
  const pagination = sales.data?.pagination;

  return (
    <div className="mt-5">
      <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('customers.salesHistory')}</h2>
      {sales.isError && <ErrorBanner {...describeError(sales.error)} />}
      <DataTable
        data-testid="customer-sales"
        loading={sales.isLoading}
        rows={sales.data?.data ?? []}
        rowKey={(s) => s.id}
        empty={t('customers.noSales')}
        onRowClick={(s) => navigate(`/sales/${s.id}`)}
        columns={[
          { key: 'number', header: t('sales.saleNumber'), className: 'numeric', cell: (s: SaleListRow) => s.saleNumber },
          { key: 'when', header: t('sales.when'), cell: (s) => formatDateTime(s.createdAt) },
          { key: 'total', header: t('sales.total'), align: 'end', className: 'numeric', cell: (s) => formatMoney(s.totalAmount) },
          {
            key: 'status',
            header: t('sales.status'),
            cell: (s) => <Badge tone={saleTone(s.status)}>{t(`sales.statusLabel.${s.status}`)}</Badge>,
          },
        ]}
      />
      {pagination && pagination.totalPages > 1 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2" data-testid="customer-sales-pagination">
          <p className="text-xs text-neutral-500">
            {t('customers.salesPageOf', { page: pagination.page, totalPages: pagination.totalPages, total: pagination.total })}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={pagination.page <= 1} onClick={() => setPage(pagination.page - 1)}>
              {t('catalogue.previous')}
            </Button>
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

// ====================================================================
function Field({ label, value, numeric, testId }: { label: string; value: string | null; numeric?: boolean; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-neutral-100 py-1 last:border-0">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className={`text-sm text-neutral-900 ${numeric ? 'numeric' : ''}`} data-testid={testId}>
        {value ?? '—'}
      </span>
    </div>
  );
}
