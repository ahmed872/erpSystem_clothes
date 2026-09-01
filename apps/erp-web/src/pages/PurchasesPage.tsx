import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, DataTable, ErrorBanner, Select } from '@retail/ui-kit';
import { purchasingApi } from '../api/purchasing';
import { inventoryApi } from '../api/inventory';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDate } from '../lib/datetime';
import { pageWindow } from '../lib/catalogue';
import { purchaseTone } from '../lib/purchasing';
import { usePermission } from '../hooks/usePermission';
import type { PurchaseListRow, PurchaseStatus } from '../lib/apiTypes';

/**
 * Phase 16 — PURCHASE ORDERS.
 *
 * Filtering and paging are the server's three filters and its own
 * pagination block. Note what the contract does NOT offer: there is no
 * free-text search over purchase numbers, so this screen does not
 * pretend to have one.
 *
 * THE TOTALS ARE THE SERVER'S. `subtotal` and `totalAmount` are computed
 * and stored when the order is created or edited; this table formats
 * strings and sums nothing.
 */
export function PurchasesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canCreate = usePermission('purchases.create');
  const canSeeSuppliers = usePermission('suppliers.view');
  const canSeeWarehouses = usePermission('warehouses.view');

  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [status, setStatus] = useState<'' | PurchaseStatus>('');
  const [page, setPage] = useState(1);

  const filters = {
    supplierId: supplierId || undefined,
    warehouseId: warehouseId || undefined,
    status: status || undefined,
    page,
  };
  const purchases = useQuery({
    queryKey: ['purchases', filters],
    queryFn: () => purchasingApi.listPurchases(filters),
    placeholderData: keepPreviousData,
  });
  const suppliers = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => purchasingApi.listSuppliers({ limit: 200 }),
    enabled: canSeeSuppliers,
  });
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => inventoryApi.listWarehouses(),
    enabled: canSeeWarehouses,
  });

  const rows = purchases.data?.data ?? [];
  const pagination = purchases.data?.pagination;

  const STATUSES: PurchaseStatus[] = ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('purchases.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('purchases.explainer')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => navigate('/purchases/new')} data-testid="new-purchase">
            {t('purchases.newPurchase')}
          </Button>
        )}
      </div>

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 p-3">
          {canSeeSuppliers && (
            <Select
              label={t('purchases.supplier')}
              value={supplierId}
              onChange={(e) => {
                setSupplierId(e.target.value);
                setPage(1);
              }}
              data-testid="filter-supplier"
            >
              <option value="">{t('purchases.allSuppliers')}</option>
              {(suppliers.data?.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
          {canSeeWarehouses && (
            <Select
              label={t('inventory.warehouse')}
              value={warehouseId}
              onChange={(e) => {
                setWarehouseId(e.target.value);
                setPage(1);
              }}
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
          <Select
            label={t('purchases.status')}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as PurchaseStatus | '');
              setPage(1);
            }}
            data-testid="filter-status"
          >
            <option value="">{t('purchases.allStatuses')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`purchases.statusLabel.${s}`)}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      {purchases.isError && <ErrorBanner {...describeError(purchases.error)} />}

      <DataTable
        data-testid="purchases-table"
        loading={purchases.isLoading}
        rows={rows}
        rowKey={(p) => p.id}
        empty={t('purchases.none')}
        onRowClick={(p) => navigate(`/purchases/${p.id}`)}
        columns={[
          { key: 'number', header: t('purchases.number'), className: 'numeric', cell: (p: PurchaseListRow) => p.purchaseNumber },
          { key: 'supplier', header: t('purchases.supplier'), cell: (p) => p.supplier?.name ?? '—' },
          { key: 'warehouse', header: t('inventory.warehouse'), cell: (p) => p.warehouse?.name ?? '—' },
          { key: 'ordered', header: t('purchases.orderDate'), cell: (p) => formatDate(p.orderDate) },
          {
            key: 'expected',
            header: t('purchases.expectedDate'),
            cell: (p) => (p.expectedDate ? formatDate(p.expectedDate) : '—'),
          },
          {
            key: 'total',
            header: t('purchases.total'),
            align: 'end',
            className: 'numeric',
            cell: (p) => formatMoney(p.totalAmount),
          },
          {
            key: 'status',
            header: t('purchases.status'),
            cell: (p) => <Badge tone={purchaseTone(p.status)}>{t(`purchases.statusLabel.${p.status}`)}</Badge>,
          },
        ]}
      />

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="purchase-pagination">
          <p className="text-xs text-neutral-500">
            {t('purchases.pageOf', { page: pagination.page, totalPages: pagination.totalPages, total: pagination.total })}
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
