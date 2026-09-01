import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Select } from '@retail/ui-kit';
import { pricingApi } from '../api/pricing';
import { catalogApi } from '../api/catalog';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { applicablePriceList, priceListRole, priceListTone, promotionChangesPricing } from '../lib/priceLists';
import { usePermission } from '../hooks/usePermission';
import type { PriceList, PriceListEntry } from '../lib/apiTypes';

/**
 * Phase 14 — PRICE LISTS: CONFIGURING THE DATA THE BACKEND PRICES FROM.
 *
 * THIS SCREEN COMPUTES NO PRICE. What a line sells for is decided by
 * `resolveSellingPrice` on the server, which reads the active default
 * list; the sale then PERSISTS the price the pipeline resolved, not the
 * one any browser proposed. Editing a price here changes what the tills
 * will charge next — it rewrites no historical sale, because every sale
 * stored its own figure at the time.
 *
 * WHAT APPLIES, EXACTLY. `isDefault` AND `isActive`, together, on one
 * list. That is the entire applicability model in the live schema. There
 * is no customer-, branch- or warehouse-scoped price list and this
 * milestone does not invent one — it remains an open owner decision, and
 * the banner below says so in the product rather than leaving a manager
 * to infer it.
 *
 * THE CASE WORTH NAMING is a default list that has been DEACTIVATED. The
 * backend then finds no applicable list and every till's own price
 * stands. A manager looking at a screen full of configured prices would
 * otherwise believe they were being enforced.
 */
export function PriceListsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canCreate = usePermission('pricelists.create');
  const canEdit = usePermission('pricelists.edit');
  const canManagePrices = usePermission('pricelists.manage_prices');

  const [selected, setSelected] = useState<PriceList | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [promoting, setPromoting] = useState<PriceList | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const lists = useQuery({ queryKey: ['price-lists'], queryFn: () => pricingApi.list() });
  const rows = lists.data?.data ?? [];
  const applicable = applicablePriceList(rows);

  function report(err: unknown) {
    setOk(null);
    setError(describeError(err));
  }

  const create = useMutation({
    mutationFn: () => pricingApi.create({ name: newName.trim() }),
    onSuccess: async () => {
      setCreating(false);
      setNewName('');
      setError(null);
      setOk(t('pricing.listCreated'));
      await queryClient.invalidateQueries({ queryKey: ['price-lists'] });
    },
    onError: report,
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { isDefault?: boolean; isActive?: boolean; name?: string } }) =>
      pricingApi.update(id, body),
    onSuccess: async (res) => {
      setPromoting(null);
      setError(null);
      setOk(t('pricing.listUpdated'));
      setSelected(res.data);
      await queryClient.invalidateQueries({ queryKey: ['price-lists'] });
    },
    onError: report,
  });

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('pricing.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('pricing.explainer')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)} data-testid="new-price-list">
            {t('pricing.newList')}
          </Button>
        )}
      </div>

      {/* States the live applicability model plainly, including the case
          where NOTHING applies. */}
      <div
        className={`mb-4 rounded-xl border p-3 ${
          applicable ? 'border-success-200 bg-success-50' : 'border-warning-200 bg-warning-50'
        }`}
        data-testid="applicability-banner"
      >
        <p className="text-xs font-semibold text-neutral-800">
          {applicable ? t('pricing.applicableIs', { name: applicable.name }) : t('pricing.noApplicable')}
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-neutral-600">{t('pricing.applicabilityNote')}</p>
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="pricing-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}
      {lists.isError && <ErrorBanner {...describeError(lists.error)} />}

      <DataTable
        data-testid="price-list-table"
        loading={lists.isLoading}
        rows={rows}
        rowKey={(l) => l.id}
        empty={t('pricing.noLists')}
        onRowClick={(l) => setSelected(l)}
        isRowActive={(l) => l.id === selected?.id}
        columns={[
          { key: 'name', header: t('pricing.name'), cell: (l: PriceList) => l.name },
          {
            key: 'role',
            header: t('pricing.role'),
            cell: (l) => {
              const role = priceListRole(l);
              return <Badge tone={priceListTone(role)}>{t(`pricing.roleLabel.${role}`)}</Badge>;
            },
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (l) => (
              <div className="flex flex-wrap justify-end gap-1">
                {canEdit && !l.isDefault && (
                  <Button size="sm" variant="ghost" onClick={() => setPromoting(l)} data-testid={`promote-${l.name}`}>
                    {t('pricing.makeDefault')}
                  </Button>
                )}
                {canEdit && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => update.mutate({ id: l.id, body: { isActive: !l.isActive } })}
                    data-testid={`toggle-${l.name}`}
                  >
                    {l.isActive ? t('pricing.deactivate') : t('pricing.activate')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      {selected && (
        <PriceListEntries
          list={selected}
          isApplicable={applicable?.id === selected.id}
          canManagePrices={canManagePrices}
          onClose={() => setSelected(null)}
          onError={report}
          onSaved={() => {
            setError(null);
            setOk(t('pricing.priceSaved'));
          }}
        />
      )}

      <ConfirmDialog
        open={creating}
        title={t('pricing.newList')}
        message={t('pricing.newListHint')}
        confirmLabel={t('common.create')}
        cancelLabel={t('common.cancel')}
        pending={create.isPending}
        onConfirm={() => create.mutate()}
        onClose={() => setCreating(false)}
        data-testid="create-list-dialog"
      >
        <Input label={t('pricing.name')} value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="new-list-name" />
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(promoting)}
        tone="danger"
        title={t('pricing.makeDefault')}
        // Named loudly because it changes what every till charges, and the
        // server demotes the current default as a side effect.
        message={
          promoting && promotionChangesPricing(promoting, rows)
            ? t('pricing.promoteWarning', { name: promoting.name })
            : t('pricing.promoteNeutral')
        }
        confirmLabel={t('pricing.makeDefault')}
        cancelLabel={t('common.cancel')}
        pending={update.isPending}
        onConfirm={() => promoting && update.mutate({ id: promoting.id, body: { isDefault: true } })}
        onClose={() => setPromoting(null)}
        data-testid="promote-dialog"
      />
    </div>
  );
}

// ====================================================================
function PriceListEntries({
  list,
  isApplicable,
  canManagePrices,
  onClose,
  onError,
  onSaved,
}: {
  list: PriceList;
  isApplicable: boolean;
  canManagePrices: boolean;
  onClose: () => void;
  onError: (e: unknown) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<PriceListEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [variantId, setVariantId] = useState('');
  const [price, setPrice] = useState('');

  const entries = useQuery({ queryKey: ['price-list', list.id], queryFn: () => pricingApi.listEntries(list.id) });
  const products = useQuery({
    queryKey: ['products', 'priceable'],
    queryFn: () => catalogApi.listProducts({ status: 'ACTIVE', limit: 100 }),
    enabled: adding,
  });

  const upsert = useMutation({
    mutationFn: ({ vId, value }: { vId: string; value: number }) => pricingApi.upsertEntry(list.id, vId, value),
    onSuccess: async () => {
      setEditing(null);
      setAdding(false);
      setVariantId('');
      setPrice('');
      onSaved();
      await queryClient.invalidateQueries({ queryKey: ['price-list', list.id] });
    },
    onError,
  });

  const variantOptions = (products.data?.data ?? []).flatMap((p) =>
    p.variants.filter((v) => v.status === 'ACTIVE').map((v) => ({ id: v.id, label: `${p.name} · ${v.sku}` })),
  );

  return (
    <Card className="mt-4">
      <CardBody className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-neutral-900">{list.name}</h2>
            <p className="text-xs text-neutral-500">
              {isApplicable ? t('pricing.thisListApplies') : t('pricing.thisListDoesNotApply')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canManagePrices && (
              <Button size="sm" variant="secondary" onClick={() => setAdding(true)} data-testid="add-price">
                {t('pricing.addPrice')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </div>

        {entries.isError && <ErrorBanner {...describeError(entries.error)} />}

        <DataTable
          data-testid="price-entry-table"
          loading={entries.isLoading}
          rows={entries.data?.data ?? []}
          rowKey={(e) => e.id}
          empty={t('pricing.noPrices')}
          columns={[
            { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (e: PriceListEntry) => e.variant.sku },
            { key: 'product', header: t('catalogue.name'), cell: (e) => e.variant.product.name },
            {
              key: 'price',
              header: t('pricing.price'),
              align: 'end',
              className: 'numeric',
              cell: (e) => formatMoney(e.price),
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              cell: (e) =>
                canManagePrices ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(e);
                      setPrice(e.price);
                    }}
                    data-testid={`edit-price-${e.variant.sku}`}
                  >
                    {t('common.edit')}
                  </Button>
                ) : null,
            },
          ]}
        />
      </CardBody>

      <ConfirmDialog
        open={adding}
        title={t('pricing.addPrice')}
        message={t('pricing.addPriceHint')}
        confirmLabel={t('common.save')}
        cancelLabel={t('common.cancel')}
        pending={upsert.isPending}
        onConfirm={() => upsert.mutate({ vId: variantId, value: Number(price) })}
        onClose={() => setAdding(false)}
        data-testid="add-price-dialog"
      >
        <Select label={t('pricing.variant')} value={variantId} onChange={(e) => setVariantId(e.target.value)} data-testid="price-variant">
          <option value="">{t('catalogue.selectVariant')}</option>
          {variantOptions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </Select>
        <Input
          label={t('pricing.price')}
          type="number"
          min="0"
          step="0.0001"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          data-testid="new-price-input"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(editing)}
        title={t('pricing.editPrice')}
        message={isApplicable ? t('pricing.editPriceApplies') : t('pricing.editPriceInert')}
        confirmLabel={t('common.save')}
        cancelLabel={t('common.cancel')}
        pending={upsert.isPending}
        onConfirm={() => editing && upsert.mutate({ vId: editing.variantId, value: Number(price) })}
        onClose={() => setEditing(null)}
        data-testid="edit-price-dialog"
      >
        <Input
          label={t('pricing.price')}
          type="number"
          min="0"
          step="0.0001"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          data-testid="edit-price-input"
        />
      </ConfirmDialog>
    </Card>
  );
}
