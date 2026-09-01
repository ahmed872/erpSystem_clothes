import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Select } from '@retail/ui-kit';
import { customersApi } from '../api/customers';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { pageWindow } from '../lib/catalogue';
import { canDeactivateCustomer, customerTone, inCredit, owesBusiness } from '../lib/customers';
import { usePermission } from '../hooks/usePermission';
import type { CustomerRow } from '../lib/apiTypes';

/**
 * Phase 18 — CUSTOMERS.
 *
 * SEARCH, FILTERING AND PAGING ARE THE SERVER'S. `GET /sales/customers`
 * takes `search`, `isActive`, `page` and `limit` and returns its own
 * pagination block. Nothing is narrowed, ranked or counted in the
 * browser — and that matters more here than elsewhere: the server ranks
 * an EXACT phone match first in SQL, before the page is cut, so a shop
 * with both "0100" and "01001234567" on file puts the person who just
 * read out their whole number at the top. Re-sorting the fetched page
 * would strand that match on page three.
 *
 * THE BALANCE IS THE SERVER'S TOO — `SUM(CustomerTransaction.amount)`,
 * computed inside the same read. This screen formats a string and adds
 * nothing up.
 *
 * DEACTIVATION, NOT DELETION, AND IT IS ONE-WAY. `DELETE` is a soft
 * delete; there is no reactivation in the contract, so none is offered.
 * See `CUSTOMER_REACTIVATION_UNSUPPORTED`.
 */
export function CustomersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canCreate = usePermission('customers.create');
  const canDeactivate = usePermission('customers.delete');

  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [deactivating, setDeactivating] = useState<CustomerRow | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const filters = {
    search: search.trim() || undefined,
    isActive: activeFilter === '' ? undefined : activeFilter === 'true',
    page,
  };
  const customers = useQuery({
    queryKey: ['customers', filters],
    queryFn: () => customersApi.list(filters),
    placeholderData: keepPreviousData,
  });

  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }
  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
  }

  const deactivate = useMutation({
    mutationFn: () => customersApi.deactivate(deactivating!.id),
    onSuccess: async () => {
      setDeactivating(null);
      await refresh(t('customers.deactivated'));
    },
    onError: (e) => {
      setDeactivating(null);
      fail(e);
    },
  });

  const rows = customers.data?.data ?? [];
  const pagination = customers.data?.pagination;

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('customers.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('customers.explainer')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)} data-testid="new-customer">
            {t('customers.newCustomer')}
          </Button>
        )}
      </div>

      <Card className="mb-4">
        <CardBody className="p-3">
          <div className="flex flex-wrap items-end gap-3">
            <Input
              label={t('customers.search')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder={t('customers.searchHint')}
              data-testid="customer-search"
            />
            <Select
              label={t('customers.state')}
              value={activeFilter}
              onChange={(e) => {
                setActiveFilter(e.target.value as '' | 'true' | 'false');
                setPage(1);
              }}
              data-testid="customer-state"
            >
              <option value="">{t('customers.allStates')}</option>
              <option value="true">{t('customers.activeLabel')}</option>
              <option value="false">{t('customers.inactiveLabel')}</option>
            </Select>
          </div>
          <p className="mt-2 text-xs text-neutral-500">{t('customers.filtersHint')}</p>
        </CardBody>
      </Card>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="customer-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}
      {customers.isError && <ErrorBanner {...describeError(customers.error)} />}

      <DataTable
        data-testid="customers-table"
        loading={customers.isLoading}
        rows={rows}
        rowKey={(c) => c.id}
        empty={t('customers.none')}
        onRowClick={(c) => navigate(`/customers/${c.id}`)}
        columns={[
          { key: 'name', header: t('customers.name'), cell: (c: CustomerRow) => c.name },
          { key: 'phone', header: t('customers.phone'), className: 'numeric', cell: (c) => c.phone ?? '—' },
          { key: 'email', header: t('customers.email'), cell: (c) => c.email ?? '—' },
          {
            key: 'balance',
            header: t('customers.balance'),
            align: 'end',
            className: 'numeric',
            // The server's own ledger sum. Coloured by comparison, never
            // recomputed: positive means the customer owes the business.
            cell: (c) => (
              <span className={owesBusiness(c) ? 'font-bold text-warning-700' : inCredit(c) ? 'font-bold text-success-700' : ''}>
                {formatMoney(c.balance)}
              </span>
            ),
          },
          {
            key: 'state',
            header: t('customers.state'),
            cell: (c) => (
              <Badge tone={customerTone(c)}>{t(c.isActive ? 'customers.activeLabel' : 'customers.inactiveLabel')}</Badge>
            ),
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (c) => (
              <div className="flex flex-wrap justify-end gap-1">
                {canDeactivate && canDeactivateCustomer(c) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeactivating(c);
                    }}
                    data-testid={`deactivate-customer-${c.id}`}
                  >
                    {t('customers.deactivate')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="customer-pagination">
          <p className="text-xs text-neutral-500">
            {t('customers.pageOf', { page: pagination.page, totalPages: pagination.totalPages, total: pagination.total })}
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

      {creating && (
        <CustomerDialog
          customer={null}
          onClose={() => setCreating(false)}
          onError={fail}
          onSaved={async () => {
            setCreating(false);
            await refresh(t('customers.created'));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deactivating)}
        tone="danger"
        title={t('customers.deactivateTitle')}
        message={t('customers.deactivateWarning')}
        confirmLabel={t('customers.deactivate')}
        cancelLabel={t('common.cancel')}
        pending={deactivate.isPending}
        onConfirm={() => deactivate.mutate()}
        onClose={() => setDeactivating(null)}
        data-testid="deactivate-customer-dialog"
      />
    </div>
  );
}

// ====================================================================
/**
 * The create/edit form. EXACTLY the five fields the schema accepts —
 * `name` plus four optional ones. There is deliberately no credit-limit
 * box and no active/inactive switch: neither exists in the contract, and
 * because the schema is non-strict both would be dropped silently while
 * the form reported success.
 */
export function CustomerDialog({
  customer,
  onClose,
  onSaved,
  onError,
}: {
  customer: { id: string; name: string; phone: string | null; email: string | null; address: string | null; taxNumber: string | null } | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: customer?.name ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    address: customer?.address ?? '',
    taxNumber: customer?.taxNumber ?? '',
  });

  // Optional fields are OMITTED rather than sent empty: the schema types
  // them `.optional()`, and an empty string would fail the email format
  // check on a customer who simply has no email.
  const body = () => ({
    name: form.name.trim(),
    ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    ...(form.email.trim() ? { email: form.email.trim() } : {}),
    ...(form.address.trim() ? { address: form.address.trim() } : {}),
    ...(form.taxNumber.trim() ? { taxNumber: form.taxNumber.trim() } : {}),
  });

  const save = useMutation({
    mutationFn: () => (customer ? customersApi.update(customer.id, body()) : customersApi.create(body())),
    onSuccess: onSaved,
    onError,
  });

  return (
    <ConfirmDialog
      open
      title={t(customer ? 'customers.editCustomer' : 'customers.newCustomer')}
      confirmLabel={t(customer ? 'common.save' : 'common.create')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="customer-dialog"
    >
      <Input
        label={t('customers.name')}
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        data-testid="customer-name"
      />
      <Input
        label={t('customers.phone')}
        value={form.phone}
        onChange={(e) => setForm({ ...form, phone: e.target.value })}
        data-testid="customer-phone"
      />
      <Input
        label={t('customers.email')}
        type="email"
        value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })}
        data-testid="customer-email"
      />
      <Input
        label={t('customers.address')}
        value={form.address}
        onChange={(e) => setForm({ ...form, address: e.target.value })}
        data-testid="customer-address"
      />
      <Input
        label={t('customers.taxNumber')}
        value={form.taxNumber}
        onChange={(e) => setForm({ ...form, taxNumber: e.target.value })}
        data-testid="customer-tax"
      />
      {/* Said out loud rather than left as an absence a user might read as
          a bug: the contract has no credit limit and no status switch. */}
      <p className="mt-1 text-xs text-neutral-500">{t('customers.dialogHint')}</p>
    </ConfirmDialog>
  );
}
