import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, DataTable, ErrorBanner, Input, Select } from '@retail/ui-kit';
import { catalogApi } from '../api/catalog';
import { referenceApi } from '../api/reference';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { hasCost, pageWindow, productTone } from '../lib/catalogue';
import { usePermission } from '../hooks/usePermission';
import type { ProductListRow, ProductStatus, ProductType } from '../lib/apiTypes';

/**
 * Phase 14 — THE CATALOGUE.
 *
 * SEARCH AND FILTERING ARE THE SERVER'S. `GET /catalog/products` already
 * takes `search`, `categoryId`, `brandId`, `status`, `type`, `page` and
 * `limit`, and returns its own `pagination` block. Nothing is filtered or
 * counted in the browser — a client-side filter over one page of twenty
 * would quietly lie about how many products matched.
 *
 * THE COST COLUMN APPEARS ONLY IF COST ARRIVED. The server deletes
 * `defaultCost` for a caller without `products.view_cost`, so the column
 * is decided by the response rather than by a permission check here. A
 * BRANCH_MANAGER holds `products.view` and not `products.view_cost`, and
 * genuinely receives no such key.
 */
export function CataloguePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canCreate = usePermission('products.create');

  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [status, setStatus] = useState<'' | ProductStatus>('');
  const [type, setType] = useState<'' | ProductType>('');
  const [page, setPage] = useState(1);

  const filters = {
    search: search.trim() || undefined,
    categoryId: categoryId || undefined,
    brandId: brandId || undefined,
    status: status || undefined,
    type: type || undefined,
    page,
  };

  const products = useQuery({
    queryKey: ['products', filters],
    queryFn: () => catalogApi.listProducts(filters),
    // Keeps the previous page on screen while the next one loads, so
    // paging does not flash an empty table.
    placeholderData: keepPreviousData,
  });

  // Filter options come from the same reference data the setup screen
  // manages. A caller without `categories.view` simply gets no category
  // filter — the backend would refuse the call.
  const canSeeCategories = usePermission('categories.view');
  const canSeeBrands = usePermission('brands.view');
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => referenceApi.listCategories(),
    enabled: canSeeCategories,
  });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => referenceApi.listBrands(), enabled: canSeeBrands });

  const rows = products.data?.data ?? [];
  const pagination = products.data?.pagination;
  const showsCost = rows.some(hasCost);

  function resetTo(fn: () => void) {
    fn();
    setPage(1);
  }

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('catalogue.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('catalogue.explainer')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => navigate('/catalogue/new')} data-testid="new-product">
            {t('catalogue.newProduct')}
          </Button>
        )}
      </div>

      <Card className="mb-4">
        <CardBody className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            label={t('catalogue.search')}
            value={search}
            onChange={(e) => resetTo(() => setSearch(e.target.value))}
            placeholder={t('catalogue.searchHint')}
            data-testid="product-search"
          />
          {canSeeCategories && (
            <Select
              label={t('catalogue.category')}
              value={categoryId}
              onChange={(e) => resetTo(() => setCategoryId(e.target.value))}
              data-testid="filter-category"
            >
              <option value="">{t('catalogue.allCategories')}</option>
              {(categories.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
          {canSeeBrands && (
            <Select
              label={t('catalogue.brand')}
              value={brandId}
              onChange={(e) => resetTo(() => setBrandId(e.target.value))}
              data-testid="filter-brand"
            >
              <option value="">{t('catalogue.allBrands')}</option>
              {(brands.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
          <Select
            label={t('catalogue.status')}
            value={status}
            onChange={(e) => resetTo(() => setStatus(e.target.value as ProductStatus | ''))}
            data-testid="filter-status"
          >
            <option value="">{t('catalogue.allStatuses')}</option>
            <option value="ACTIVE">{t('catalogue.statusLabel.ACTIVE')}</option>
            <option value="INACTIVE">{t('catalogue.statusLabel.INACTIVE')}</option>
            <option value="DISCONTINUED">{t('catalogue.statusLabel.DISCONTINUED')}</option>
          </Select>
          <Select
            label={t('catalogue.type')}
            value={type}
            onChange={(e) => resetTo(() => setType(e.target.value as ProductType | ''))}
            data-testid="filter-type"
          >
            <option value="">{t('catalogue.allTypes')}</option>
            <option value="SIMPLE">{t('catalogue.typeLabel.SIMPLE')}</option>
            <option value="BUNDLE">{t('catalogue.typeLabel.BUNDLE')}</option>
          </Select>
        </CardBody>
      </Card>

      {products.isError && <ErrorBanner {...describeError(products.error)} />}

      <DataTable
        data-testid="product-table"
        loading={products.isLoading}
        rows={rows}
        rowKey={(p) => p.id}
        empty={t('catalogue.noProducts')}
        onRowClick={(p) => navigate(`/catalogue/${p.id}`)}
        columns={[
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (p: ProductListRow) => p.sku },
          {
            key: 'name',
            header: t('catalogue.name'),
            cell: (p) => (
              <span>
                {p.name}
                {p.alternativeName && <span className="ms-2 text-xs text-neutral-400">{p.alternativeName}</span>}
              </span>
            ),
          },
          { key: 'category', header: t('catalogue.category'), cell: (p) => p.category?.name ?? '—' },
          { key: 'brand', header: t('catalogue.brand'), cell: (p) => p.brand?.name ?? '—' },
          {
            key: 'type',
            header: t('catalogue.type'),
            cell: (p) => (p.type === 'BUNDLE' ? <Badge tone="brand">{t('catalogue.typeLabel.BUNDLE')}</Badge> : '—'),
          },
          {
            key: 'variants',
            header: t('catalogue.variants'),
            align: 'end',
            className: 'numeric',
            cell: (p) => String(p.variants.length),
          },
          {
            key: 'price',
            header: t('catalogue.defaultPrice'),
            align: 'end',
            className: 'numeric',
            cell: (p) => formatMoney(p.defaultSellingPrice),
          },
          // Rendered ONLY because the server sent it.
          ...(showsCost
            ? [
                {
                  key: 'cost',
                  header: t('catalogue.defaultCost'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (p: ProductListRow) => (p.defaultCost === undefined ? '—' : formatMoney(p.defaultCost)),
                },
              ]
            : []),
          {
            key: 'status',
            header: t('catalogue.status'),
            cell: (p) => <Badge tone={productTone(p.status)}>{t(`catalogue.statusLabel.${p.status}`)}</Badge>,
          },
        ]}
      />

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="pagination">
          <p className="text-xs text-neutral-500">
            {t('catalogue.pageOf', { page: pagination.page, totalPages: pagination.totalPages, total: pagination.total })}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={pagination.page <= 1} onClick={() => setPage(pagination.page - 1)}>
              {t('catalogue.previous')}
            </Button>
            {pageWindow(pagination.page, pagination.totalPages).map((p) => (
              <Button
                key={p}
                size="sm"
                variant={p === pagination.page ? 'primary' : 'ghost'}
                onClick={() => setPage(p)}
                data-testid={`page-${p}`}
              >
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
