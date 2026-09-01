import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Select } from '@retail/ui-kit';
import { purchasingApi } from '../api/purchasing';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { pageWindow } from '../lib/catalogue';
import { canDeactivateSupplier, hasBalance, isOwed, supplierTone } from '../lib/purchasing';
import { usePermission } from '../hooks/usePermission';
import type { Supplier } from '../lib/apiTypes';

/**
 * Phase 16 — SUPPLIERS.
 *
 * SEARCH, FILTERING AND PAGING ARE THE SERVER'S. `GET
 * /purchasing/suppliers` already takes `search`, `isActive`, `page` and
 * `limit` and returns its own pagination block, so nothing is narrowed
 * or counted in the browser.
 *
 * THE BALANCE IS THE SERVER'S TOO. `getSupplierBalance` sums the
 * supplier ledger inside the same read; this screen formats a string and
 * adds nothing up.
 *
 * DEACTIVATION, NOT DELETION. `DELETE /purchasing/suppliers/:id` is a
 * soft delete — it sets `isActive` false and refuses outright while an
 * open purchase still references the supplier, which is why the button
 * says "Deactivate" and the server's 409 is shown verbatim rather than
 * predicted.
 */
export function SuppliersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canCreate = usePermission('suppliers.create');
  const canEdit = usePermission('suppliers.edit');
  const canDeactivate = usePermission('suppliers.delete');

  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [creating, setCreating] = useState(false);
  const [deactivating, setDeactivating] = useState<Supplier | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const filters = {
    search: search.trim() || undefined,
    isActive: activeFilter === '' ? undefined : activeFilter === 'true',
    page,
  };
  const suppliers = useQuery({
    queryKey: ['suppliers', filters],
    queryFn: () => purchasingApi.listSuppliers(filters),
    placeholderData: keepPreviousData,
  });

  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }
  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
  }

  const deactivate = useMutation({
    mutationFn: () => purchasingApi.deactivateSupplier(deactivating!.id),
    onSuccess: async () => {
      setDeactivating(null);
      await refresh(t('suppliers.deactivated'));
    },
    onError: fail,
  });

  const rows = suppliers.data?.data ?? [];
  const pagination = suppliers.data?.pagination;
  const showsBalance = rows.some(hasBalance);

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('suppliers.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('suppliers.explainer')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)} data-testid="new-supplier">
            {t('suppliers.newSupplier')}
          </Button>
        )}
      </div>

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 p-3">
          <Input
            label={t('suppliers.search')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('suppliers.searchHint')}
            data-testid="supplier-search"
          />
          <Select
            label={t('suppliers.state')}
            value={activeFilter}
            onChange={(e) => {
              setActiveFilter(e.target.value as '' | 'true' | 'false');
              setPage(1);
            }}
            data-testid="supplier-state"
          >
            <option value="">{t('suppliers.allStates')}</option>
            <option value="true">{t('suppliers.activeLabel')}</option>
            <option value="false">{t('suppliers.inactiveLabel')}</option>
          </Select>
        </CardBody>
      </Card>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="supplier-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}
      {suppliers.isError && <ErrorBanner {...describeError(suppliers.error)} />}

      <DataTable
        data-testid="suppliers-table"
        loading={suppliers.isLoading}
        rows={rows}
        rowKey={(s) => s.id}
        empty={t('suppliers.none')}
        columns={[
          { key: 'name', header: t('suppliers.name'), cell: (s: Supplier) => s.name },
          { key: 'contact', header: t('suppliers.contactPerson'), cell: (s) => s.contactPerson ?? '—' },
          { key: 'phone', header: t('suppliers.phone'), className: 'numeric', cell: (s) => s.phone ?? '—' },
          {
            key: 'terms',
            header: t('suppliers.paymentTerms'),
            align: 'end',
            className: 'numeric',
            cell: (s) => (s.paymentTermsDays === null ? '—' : t('suppliers.days', { days: s.paymentTermsDays })),
          },
          // The server's own ledger sum, rendered only where it arrived.
          ...(showsBalance
            ? [
                {
                  key: 'balance',
                  header: t('suppliers.balance'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (s: Supplier) =>
                    s.balance === undefined ? '—' : (
                      <span className={isOwed(s) ? 'font-bold text-warning-700' : ''}>{formatMoney(s.balance)}</span>
                    ),
                },
              ]
            : []),
          {
            key: 'state',
            header: t('suppliers.state'),
            cell: (s) => (
              <Badge tone={supplierTone(s)}>{t(s.isActive ? 'suppliers.activeLabel' : 'suppliers.inactiveLabel')}</Badge>
            ),
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (s) => (
              <div className="flex flex-wrap justify-end gap-1">
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(s)} data-testid={`edit-supplier-${s.id}`}>
                    {t('common.edit')}
                  </Button>
                )}
                {canDeactivate && canDeactivateSupplier(s) && (
                  <Button size="sm" variant="ghost" onClick={() => setDeactivating(s)} data-testid={`deactivate-supplier-${s.id}`}>
                    {t('suppliers.deactivate')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="supplier-pagination">
          <p className="text-xs text-neutral-500">
            {t('suppliers.pageOf', { page: pagination.page, totalPages: pagination.totalPages, total: pagination.total })}
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

      {(creating || editing) && (
        <SupplierDialog
          supplier={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onError={fail}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await refresh(t(editing ? 'suppliers.updated' : 'suppliers.created'));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deactivating)}
        tone="danger"
        title={t('suppliers.deactivateTitle')}
        message={t('suppliers.deactivateWarning')}
        confirmLabel={t('suppliers.deactivate')}
        cancelLabel={t('common.cancel')}
        pending={deactivate.isPending}
        onConfirm={() => deactivate.mutate()}
        onClose={() => setDeactivating(null)}
        data-testid="deactivate-supplier-dialog"
      />
    </div>
  );
}

// ====================================================================
function SupplierDialog({
  supplier,
  onClose,
  onSaved,
  onError,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: supplier?.name ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    taxNumber: supplier?.taxNumber ?? '',
    paymentTermsDays: supplier?.paymentTermsDays?.toString() ?? '',
  });

  // Optional fields are OMITTED rather than sent empty: the schema types
  // them `.optional()`, and an empty string would fail the email format
  // check on a supplier that simply has no email.
  const body = () => ({
    name: form.name.trim(),
    ...(form.contactPerson.trim() ? { contactPerson: form.contactPerson.trim() } : {}),
    ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    ...(form.email.trim() ? { email: form.email.trim() } : {}),
    ...(form.address.trim() ? { address: form.address.trim() } : {}),
    ...(form.taxNumber.trim() ? { taxNumber: form.taxNumber.trim() } : {}),
    ...(form.paymentTermsDays.trim() ? { paymentTermsDays: Number(form.paymentTermsDays) } : {}),
  });

  const save = useMutation({
    mutationFn: () => (supplier ? purchasingApi.updateSupplier(supplier.id, body()) : purchasingApi.createSupplier(body())),
    onSuccess: onSaved,
    onError,
  });

  return (
    <ConfirmDialog
      open
      title={t(supplier ? 'suppliers.editSupplier' : 'suppliers.newSupplier')}
      confirmLabel={t(supplier ? 'common.save' : 'common.create')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="supplier-dialog"
    >
      <Input
        label={t('suppliers.name')}
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        data-testid="supplier-name"
      />
      <Input
        label={t('suppliers.contactPerson')}
        value={form.contactPerson}
        onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
        data-testid="supplier-contact"
      />
      <Input
        label={t('suppliers.phone')}
        value={form.phone}
        onChange={(e) => setForm({ ...form, phone: e.target.value })}
        data-testid="supplier-phone"
      />
      <Input
        label={t('suppliers.email')}
        type="email"
        value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })}
        data-testid="supplier-email"
      />
      <Input
        label={t('suppliers.taxNumber')}
        value={form.taxNumber}
        onChange={(e) => setForm({ ...form, taxNumber: e.target.value })}
      />
      <Input
        label={t('suppliers.paymentTerms')}
        type="number"
        min="0"
        max="3650"
        value={form.paymentTermsDays}
        onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })}
        data-testid="supplier-terms"
      />
    </ConfirmDialog>
  );
}
