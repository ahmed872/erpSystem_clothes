import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, DataTable, ErrorBanner, Input, Select } from '@retail/ui-kit';
import { salesApi } from '../api/sales';
import { inventoryApi } from '../api/inventory';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDateTime } from '../lib/datetime';
import { pageWindow } from '../lib/catalogue';
import { saleTone } from '../lib/sales';
import { usePermission } from '../hooks/usePermission';
import type { SaleListRow } from '../lib/apiTypes';

/**
 * Phase 17 — SALES.
 *
 * A MANAGEMENT VIEW, NOT A TILL. The POS sells; this screen finds and
 * inspects what was sold. There is no basket, no checkout and no quote
 * here, deliberately.
 *
 * THE FILTERS ARE EXACTLY THE FIVE THE CONTRACT ACCEPTS. `saleNumber` is
 * an EXACT, index-backed lookup rather than a search — it answers "find
 * the receipt in this customer's hand", which is the question a back
 * office actually asks. The live query has NO date range and NO status
 * filter, so this screen offers neither rather than filtering a page of
 * fifty rows in the browser and calling it a filter.
 *
 * THERE IS NO PAYMENT COLUMN, and that is a decision rather than an
 * omission: `GET /sales` does not carry the payment summary, and deriving
 * one from `totalAmount` would label every settled cash sale "unpaid".
 * Opening the sale answers it. See `lib/sales.ts`.
 */
export function SalesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canSeeCustomers = usePermission('customers.view');
  const canSeeWarehouses = usePermission('warehouses.view');

  const [saleNumber, setSaleNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [page, setPage] = useState(1);

  const filters = {
    saleNumber: saleNumber.trim() || undefined,
    customerId: customerId || undefined,
    warehouseId: warehouseId || undefined,
    page,
  };
  const sales = useQuery({
    queryKey: ['sales', filters],
    queryFn: () => salesApi.list(filters),
    placeholderData: keepPreviousData,
  });
  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => salesApi.listCustomers(),
    enabled: canSeeCustomers,
  });
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => inventoryApi.listWarehouses(),
    enabled: canSeeWarehouses,
  });

  const rows = sales.data?.data ?? [];
  const pagination = sales.data?.pagination;

  function reset(fn: () => void) {
    fn();
    setPage(1);
  }

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('sales.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('sales.explainer')}</p>

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 p-3">
          <Input
            label={t('sales.saleNumber')}
            value={saleNumber}
            onChange={(e) => reset(() => setSaleNumber(e.target.value))}
            placeholder={t('sales.saleNumberHint')}
            data-testid="sale-number"
          />
          {canSeeCustomers && (
            <Select
              label={t('sales.customer')}
              value={customerId}
              onChange={(e) => reset(() => setCustomerId(e.target.value))}
              data-testid="filter-customer"
            >
              <option value="">{t('sales.allCustomers')}</option>
              {(customers.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
          {canSeeWarehouses && (
            <Select
              label={t('inventory.warehouse')}
              value={warehouseId}
              onChange={(e) => reset(() => setWarehouseId(e.target.value))}
              data-testid="filter-warehouse"
            >
              <option value="">{t('inventory.allWarehouses')}</option>
              {(warehouses.data?.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
          <p className="mb-2 text-xs text-neutral-500">{t('sales.filtersHint')}</p>
        </CardBody>
      </Card>

      {sales.isError && <ErrorBanner {...describeError(sales.error)} />}

      <DataTable
        data-testid="sales-table"
        loading={sales.isLoading}
        rows={rows}
        rowKey={(s) => s.id}
        empty={t('sales.none')}
        onRowClick={(s) => navigate(`/sales/${s.id}`)}
        columns={[
          { key: 'number', header: t('sales.saleNumber'), className: 'numeric', cell: (s: SaleListRow) => s.saleNumber },
          { key: 'when', header: t('sales.when'), cell: (s) => formatDateTime(s.createdAt) },
          { key: 'customer', header: t('sales.customer'), cell: (s) => s.customer?.name ?? t('sales.walkIn') },
          { key: 'warehouse', header: t('inventory.warehouse'), cell: (s) => s.warehouse?.name ?? '—' },
          {
            key: 'discount',
            header: t('sales.discount'),
            align: 'end',
            className: 'numeric',
            cell: (s) => formatMoney(s.discountAmount),
          },
          { key: 'tax', header: t('sales.tax'), align: 'end', className: 'numeric', cell: (s) => formatMoney(s.taxAmount) },
          {
            key: 'total',
            header: t('sales.total'),
            align: 'end',
            className: 'numeric',
            cell: (s) => formatMoney(s.totalAmount),
          },
          {
            key: 'status',
            header: t('sales.status'),
            cell: (s) => (
              <span className="flex items-center gap-1">
                <Badge tone={saleTone(s.status)}>{t(`sales.statusLabel.${s.status}`)}</Badge>
                {/* A sale created as an exchange says so, rather than
                    showing a bare id the reader cannot use. */}
                {s.exchangeForReturnId && <Badge tone="brand">{t('sales.exchange')}</Badge>}
              </span>
            ),
          },
        ]}
      />

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="sales-pagination">
          <p className="text-xs text-neutral-500">
            {t('sales.pageOf', { page: pagination.page, totalPages: pagination.totalPages, total: pagination.total })}
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
