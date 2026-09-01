import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Spinner,
} from '@retail/ui-kit';
import { catalogApi } from '../api/catalog';
import { referenceApi } from '../api/reference';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import {
  bundleComponents,
  canEditBundle,
  DEACTIVATED_STATUS,
  primaryBarcode,
  productTone,
  variantHasCost,
  variantAttributes,
  variantTone,
} from '../lib/catalogue';
import { usePermission } from '../hooks/usePermission';
import type { ProductDetail, ProductStatus, Variant } from '../lib/apiTypes';

/**
 * Phase 14 — ONE PRODUCT, AND THE SEPARATE GRANTS THAT GOVERN IT.
 *
 * The backend splits what looks like one "edit product" job across four
 * permissions, and this screen keeps them visibly apart rather than
 * hiding the split behind a single Save:
 *
 *   products.edit          name, category, brand, tax, status, tracking
 *   products.create        adding a further variant
 *   products.change_cost   a variant's cost
 *   products.change_price  a variant's shelf price
 *
 * That is not pedantry. An INVENTORY_MANAGER holds the first three and
 * NOT the fourth: they build the catalogue and set cost, and the shelf
 * price is someone else's decision. A single form would either hand them
 * a field the server refuses, or hide fields they are entitled to.
 *
 * THERE IS NO DELETE. `products.delete` exists as a permission code but
 * no live route consults it; the contract is deactivation, and inventing
 * a delete would mean inventing semantics the owner has deferred. See
 * `lib/catalogue.ts`.
 */
export function ProductDetailPage() {
  const { t } = useTranslation();
  const { productId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const canEdit = usePermission('products.edit');
  const canCreate = usePermission('products.create');
  const canChangeCost = usePermission('products.change_cost');
  const canChangePrice = usePermission('products.change_price');
  const canSeeTaxes = usePermission('tax.view');
  const canSeeCategories = usePermission('categories.view');
  const canSeeBrands = usePermission('brands.view');

  const [banner, setBanner] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const detail = useQuery({ queryKey: ['product', productId], queryFn: () => catalogApi.getProduct(productId) });
  const taxes = useQuery({ queryKey: ['taxes'], queryFn: () => referenceApi.listTaxes(), enabled: canSeeTaxes });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => referenceApi.listCategories(),
    enabled: canSeeCategories,
  });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => referenceApi.listBrands(), enabled: canSeeBrands });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['product', productId] });
    await queryClient.invalidateQueries({ queryKey: ['products'] });
  }

  function report(err: unknown) {
    setOk(null);
    setBanner(describeError(err));
  }
  function succeed(key: string) {
    setBanner(null);
    setOk(t(key));
  }

  if (detail.isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="mx-auto max-w-4xl p-4">
        <ErrorBanner {...describeError(detail.error)} />
      </div>
    );
  }

  const product = detail.data!.data;

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold text-neutral-900" data-testid="product-name">
              {product.name}
            </h1>
            <Badge tone={productTone(product.status)}>{t(`catalogue.statusLabel.${product.status}`)}</Badge>
            {product.type === 'BUNDLE' && <Badge tone="brand">{t('catalogue.typeLabel.BUNDLE')}</Badge>}
          </div>
          <p className="numeric text-xs text-neutral-500">{product.sku}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/catalogue')}>
          {t('catalogue.backToList')}
        </Button>
      </div>

      {banner && <ErrorBanner title={banner.title} message={banner.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="success-banner">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}

      <ProductFacts
        product={product}
        canEdit={canEdit}
        categories={categories.data?.data ?? []}
        brands={brands.data?.data ?? []}
        taxes={taxes.data?.data ?? []}
        canSeeTaxes={canSeeTaxes}
        onSaved={async () => {
          succeed('catalogue.saved');
          await refresh();
        }}
        onError={report}
      />

      <VariantsSection
        product={product}
        canCreate={canCreate}
        canEdit={canEdit}
        canChangeCost={canChangeCost}
        canChangePrice={canChangePrice}
        onSaved={async (key) => {
          succeed(key);
          await refresh();
        }}
        onError={report}
      />

      {canEditBundle(product) && (
        <BundleSection
          product={product}
          canEdit={canEdit}
          onSaved={async () => {
            succeed('catalogue.bundleSaved');
            await refresh();
          }}
          onError={report}
        />
      )}
    </div>
  );
}

// ====================================================================
function ProductFacts({
  product,
  canEdit,
  categories,
  brands,
  taxes,
  canSeeTaxes,
  onSaved,
  onError,
}: {
  product: ProductDetail;
  canEdit: boolean;
  categories: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  taxes: { id: string; name: string; ratePercent: string }[];
  canSeeTaxes: boolean;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: product.name,
    alternativeName: product.alternativeName ?? '',
    description: product.description ?? '',
    categoryId: product.categoryId ?? '',
    brandId: product.brandId ?? '',
    status: product.status as ProductStatus,
    taxId: product.taxId ?? '',
    taxExempt: product.taxExempt,
  });
  const [deactivating, setDeactivating] = useState(false);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => catalogApi.updateProduct(product.id, body),
    onSuccess: async () => {
      setEditing(false);
      setDeactivating(false);
      await onSaved();
    },
    onError,
  });

  const taxLabel = product.taxExempt
    ? t('catalogue.taxExempt')
    : product.taxId
      ? (taxes.find((x) => x.id === product.taxId)?.name ?? product.taxId)
      : t('catalogue.taxBusinessDefault');

  return (
    <Card className="mb-4">
      <CardBody className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-neutral-900">{t('catalogue.details')}</h2>
          {canEdit && !editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)} data-testid="edit-product">
              {t('common.edit')}
            </Button>
          )}
        </div>

        {!editing ? (
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            <Fact label={t('catalogue.name')} value={product.name} />
            <Fact label={t('catalogue.alternativeName')} value={product.alternativeName ?? '—'} />
            <Fact label={t('catalogue.category')} value={product.category?.name ?? '—'} />
            <Fact label={t('catalogue.brand')} value={product.brand?.name ?? '—'} />
            <Fact label={t('catalogue.baseUom')} value={`${product.baseUom.name} (${product.baseUom.code})`} />
            {/* The backend is authoritative for the RATE and every computed
                amount; the catalogue only records WHICH tax applies. */}
            {canSeeTaxes && <Fact label={t('catalogue.tax')} value={taxLabel} testId="product-tax" />}
            <Fact label={t('catalogue.tracksLots')} value={product.tracksLots ? t('common.yes') : t('common.no')} />
            <Fact
              label={t('catalogue.tracksSerials')}
              value={product.tracksSerialNumbers ? t('common.yes') : t('common.no')}
            />
            {product.description && <Fact label={t('catalogue.description')} value={product.description} />}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t('catalogue.name')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              data-testid="edit-name"
            />
            <Input
              label={t('catalogue.alternativeName')}
              value={form.alternativeName}
              onChange={(e) => setForm({ ...form, alternativeName: e.target.value })}
            />
            <Select
              label={t('catalogue.category')}
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
            >
              <option value="">{t('catalogue.none')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select
              label={t('catalogue.brand')}
              value={form.brandId}
              onChange={(e) => setForm({ ...form, brandId: e.target.value })}
            >
              <option value="">{t('catalogue.none')}</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Select
              label={t('catalogue.status')}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as ProductStatus })}
              data-testid="edit-status"
            >
              <option value="ACTIVE">{t('catalogue.statusLabel.ACTIVE')}</option>
              <option value="INACTIVE">{t('catalogue.statusLabel.INACTIVE')}</option>
              <option value="DISCONTINUED">{t('catalogue.statusLabel.DISCONTINUED')}</option>
            </Select>
            {canSeeTaxes && (
              <Select
                label={t('catalogue.tax')}
                value={form.taxExempt ? 'EXEMPT' : form.taxId}
                onChange={(e) =>
                  setForm(
                    e.target.value === 'EXEMPT'
                      ? { ...form, taxExempt: true, taxId: '' }
                      : { ...form, taxExempt: false, taxId: e.target.value },
                  )
                }
                data-testid="edit-tax"
              >
                {/* Omitting a tax means the BUSINESS DEFAULT applies;
                    exemption is explicit and never inferred from absence. */}
                <option value="">{t('catalogue.taxBusinessDefault')}</option>
                {taxes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} · {x.ratePercent}%
                  </option>
                ))}
                <option value="EXEMPT">{t('catalogue.taxExempt')}</option>
              </Select>
            )}
            <Input
              label={t('catalogue.description')}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <div className="flex items-end gap-2 sm:col-span-2">
              <Button
                loading={save.isPending}
                disabled={save.isPending}
                data-testid="save-product"
                onClick={() =>
                  save.mutate({
                    name: form.name,
                    alternativeName: form.alternativeName.trim() || null,
                    description: form.description.trim() || null,
                    categoryId: form.categoryId || null,
                    brandId: form.brandId || null,
                    status: form.status,
                    taxId: form.taxExempt ? null : form.taxId || null,
                    taxExempt: form.taxExempt,
                  })
                }
              >
                {t('common.save')}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={save.isPending}>
                {t('common.cancel')}
              </Button>
              {/* DEACTIVATION, NOT DELETION — the contract has no delete. */}
              {product.status === 'ACTIVE' && (
                <Button variant="danger" className="ms-auto" onClick={() => setDeactivating(true)} data-testid="deactivate-product">
                  {t('catalogue.deactivate')}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardBody>

      <ConfirmDialog
        open={deactivating}
        tone="danger"
        title={t('catalogue.deactivateTitle')}
        message={t('catalogue.deactivateWarning')}
        confirmLabel={t('catalogue.deactivate')}
        cancelLabel={t('common.cancel')}
        pending={save.isPending}
        onConfirm={() => save.mutate({ status: DEACTIVATED_STATUS })}
        onClose={() => setDeactivating(false)}
        data-testid="deactivate-dialog"
      />
    </Card>
  );
}

function Fact({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-neutral-100 py-1 text-sm last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className="text-end font-medium text-neutral-800" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

// ====================================================================
function VariantsSection({
  product,
  canCreate,
  canEdit,
  canChangeCost,
  canChangePrice,
  onSaved,
  onError,
}: {
  product: ProductDetail;
  canCreate: boolean;
  canEdit: boolean;
  canChangeCost: boolean;
  canChangePrice: boolean;
  onSaved: (key: string) => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [newSku, setNewSku] = useState('');
  const [pricing, setPricing] = useState<Variant | null>(null);
  const [costing, setCosting] = useState<Variant | null>(null);
  const [barcoding, setBarcoding] = useState<Variant | null>(null);
  const [amount, setAmount] = useState('');
  const [barcode, setBarcode] = useState('');

  const showsCost = product.variants.some(variantHasCost);

  const addVariant = useMutation({
    mutationFn: () => catalogApi.addVariant(product.id, { sku: newSku.trim() }),
    onSuccess: async () => {
      setAdding(false);
      setNewSku('');
      await onSaved('catalogue.variantAdded');
    },
    onError,
  });

  const setPrice = useMutation({
    mutationFn: () => catalogApi.changeVariantPrice(pricing!.id, Number(amount)),
    onSuccess: async () => {
      setPricing(null);
      setAmount('');
      await onSaved('catalogue.priceChanged');
    },
    onError,
  });

  const setCost = useMutation({
    mutationFn: () => catalogApi.changeVariantCost(costing!.id, Number(amount)),
    onSuccess: async () => {
      setCosting(null);
      setAmount('');
      await onSaved('catalogue.costChanged');
    },
    onError,
  });

  const addBarcode = useMutation({
    mutationFn: () => catalogApi.addBarcode(barcoding!.id, barcode.trim(), barcoding!.barcodes.length === 0),
    onSuccess: async () => {
      setBarcoding(null);
      setBarcode('');
      await onSaved('catalogue.barcodeAdded');
    },
    onError,
  });

  const toggleVariant = useMutation({
    mutationFn: (v: Variant) =>
      catalogApi.updateVariant(v.id, { status: v.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
    onSuccess: () => onSaved('catalogue.variantUpdated'),
    onError,
  });

  return (
    <Card className="mb-4">
      <CardBody className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-neutral-900">{t('catalogue.variants')}</h2>
          {canCreate && (
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)} data-testid="add-variant">
              {t('catalogue.addVariant')}
            </Button>
          )}
        </div>

        <DataTable
          data-testid="variant-table"
          rows={product.variants}
          rowKey={(v) => v.id}
          empty={t('catalogue.noVariants')}
          columns={[
            { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (v: Variant) => v.sku },
            { key: 'label', header: t('catalogue.attributes'), cell: (v) => variantAttributes(v) ?? '—' },
            { key: 'barcode', header: t('catalogue.barcode'), className: 'numeric', cell: (v) => primaryBarcode(v) ?? '—' },
            {
              key: 'price',
              header: t('catalogue.sellingPrice'),
              align: 'end',
              className: 'numeric',
              cell: (v) => formatMoney(v.sellingPrice),
            },
            // Cost appears only where the server sent it.
            ...(showsCost
              ? [
                  {
                    key: 'cost',
                    header: t('catalogue.cost'),
                    align: 'end' as const,
                    className: 'numeric',
                    cell: (v: Variant) => (v.cost === undefined ? '—' : formatMoney(v.cost)),
                  },
                ]
              : []),
            {
              key: 'status',
              header: t('catalogue.status'),
              cell: (v) => <Badge tone={variantTone(v.status)}>{t(`catalogue.variantStatus.${v.status}`)}</Badge>,
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              cell: (v) => (
                <div className="flex flex-wrap justify-end gap-1">
                  {/* One control per GRANT, because the backend has one
                      endpoint per grant. */}
                  {canChangePrice && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setPricing(v);
                        setAmount(v.sellingPrice);
                      }}
                      data-testid={`price-${v.sku}`}
                    >
                      {t('catalogue.setPrice')}
                    </Button>
                  )}
                  {canChangeCost && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setCosting(v);
                        setAmount(v.cost ?? '');
                      }}
                      data-testid={`cost-${v.sku}`}
                    >
                      {t('catalogue.setCost')}
                    </Button>
                  )}
                  {canEdit && (
                    <Button size="sm" variant="ghost" onClick={() => setBarcoding(v)} data-testid={`barcode-${v.sku}`}>
                      {t('catalogue.addBarcode')}
                    </Button>
                  )}
                  {canEdit && (
                    <Button size="sm" variant="ghost" onClick={() => toggleVariant.mutate(v)} data-testid={`toggle-${v.sku}`}>
                      {v.status === 'ACTIVE' ? t('catalogue.deactivate') : t('catalogue.activate')}
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </CardBody>

      <ConfirmDialog
        open={adding}
        title={t('catalogue.addVariant')}
        message={t('catalogue.addVariantHint')}
        confirmLabel={t('common.add')}
        cancelLabel={t('common.cancel')}
        pending={addVariant.isPending}
        onConfirm={() => addVariant.mutate()}
        onClose={() => setAdding(false)}
        data-testid="add-variant-dialog"
      >
        <Input label={t('catalogue.sku')} value={newSku} onChange={(e) => setNewSku(e.target.value)} data-testid="new-variant-sku" />
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(pricing)}
        title={t('catalogue.setPrice')}
        message={t('catalogue.setPriceHint')}
        confirmLabel={t('common.save')}
        cancelLabel={t('common.cancel')}
        pending={setPrice.isPending}
        onConfirm={() => setPrice.mutate()}
        onClose={() => setPricing(null)}
        data-testid="price-dialog"
      >
        <Input
          label={t('catalogue.sellingPrice')}
          type="number"
          min="0"
          step="0.0001"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          data-testid="price-input"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(costing)}
        title={t('catalogue.setCost')}
        message={t('catalogue.setCostHint')}
        confirmLabel={t('common.save')}
        cancelLabel={t('common.cancel')}
        pending={setCost.isPending}
        onConfirm={() => setCost.mutate()}
        onClose={() => setCosting(null)}
        data-testid="cost-dialog"
      >
        <Input
          label={t('catalogue.cost')}
          type="number"
          min="0"
          step="0.0001"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          data-testid="cost-input"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(barcoding)}
        title={t('catalogue.addBarcode')}
        message={t('catalogue.addBarcodeHint')}
        confirmLabel={t('common.add')}
        cancelLabel={t('common.cancel')}
        pending={addBarcode.isPending}
        onConfirm={() => addBarcode.mutate()}
        onClose={() => setBarcoding(null)}
        data-testid="barcode-dialog"
      >
        <Input label={t('catalogue.barcode')} value={barcode} onChange={(e) => setBarcode(e.target.value)} data-testid="barcode-input" />
      </ConfirmDialog>
    </Card>
  );
}

// ====================================================================
/**
 * Bundle composition. The backend REPLACES the whole list (PUT) and
 * validates every component itself — a bundle may not contain itself, and
 * each component must be a variant of this tenant. What selling a bundle
 * consumes from stock is `InventoryEngineService` and is not modelled
 * here at all.
 */
function BundleSection({
  product,
  canEdit,
  onSaved,
  onError,
}: {
  product: ProductDetail;
  canEdit: boolean;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<{ variantId: string; quantity: string }[]>([]);
  const [candidate, setCandidate] = useState('');
  const [quantity, setQuantity] = useState('1');

  // Candidate components: every ACTIVE variant in the catalogue except
  // this bundle's own. The server re-validates regardless.
  const all = useQuery({
    queryKey: ['products', 'bundle-candidates'],
    queryFn: () => catalogApi.listProducts({ type: 'SIMPLE', status: 'ACTIVE', limit: 100 }),
    enabled: editing,
  });

  const save = useMutation({
    mutationFn: () =>
      catalogApi.replaceBundleItems(
        product.id,
        items.map((i) => ({ variantId: i.variantId, quantity: Number(i.quantity) })),
      ),
    onSuccess: async () => {
      setEditing(false);
      await onSaved();
    },
    onError,
  });

  const components = bundleComponents(product.bundleItems);
  const candidates = (all.data?.data ?? []).flatMap((p) =>
    p.variants.filter((v) => v.status === 'ACTIVE').map((v) => ({ id: v.id, label: `${p.name} · ${v.sku}` })),
  );

  return (
    <Card className="mb-4">
      <CardBody className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-neutral-900">{t('catalogue.bundleComposition')}</h2>
          {canEdit && !editing && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setItems(components.map((c) => ({ variantId: c.variantId, quantity: c.quantity })));
                setEditing(true);
              }}
              data-testid="edit-bundle"
            >
              {t('common.edit')}
            </Button>
          )}
        </div>
        <p className="mb-2 text-xs leading-snug text-neutral-500">{t('catalogue.bundleExplainer')}</p>

        {!editing ? (
          <DataTable
            data-testid="bundle-table"
            rows={components}
            rowKey={(c) => c.variantId}
            empty={t('catalogue.noComponents')}
            columns={[
              { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (c) => c.sku },
              { key: 'name', header: t('catalogue.name'), cell: (c) => c.name },
              { key: 'qty', header: t('catalogue.quantity'), align: 'end', className: 'numeric', cell: (c) => c.quantity },
            ]}
          />
        ) : (
          <div className="flex flex-col gap-2" data-testid="bundle-editor">
            {items.map((item, idx) => {
              const label =
                candidates.find((c) => c.id === item.variantId)?.label ??
                components.find((c) => c.variantId === item.variantId)?.name ??
                item.variantId;
              return (
                <div key={item.variantId} className="flex items-center gap-2 rounded-lg border border-neutral-200 p-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                  <Input
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    value={item.quantity}
                    onChange={(e) => {
                      const next = [...items];
                      next[idx] = { ...item, quantity: e.target.value };
                      setItems(next);
                    }}
                    className="w-28"
                  />
                  <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, i) => i !== idx))}>
                    {t('common.remove')}
                  </Button>
                </div>
              );
            })}

            <div className="flex flex-wrap items-end gap-2">
              <Select
                label={t('catalogue.addComponent')}
                value={candidate}
                onChange={(e) => setCandidate(e.target.value)}
                data-testid="bundle-candidate"
              >
                <option value="">{t('catalogue.selectVariant')}</option>
                {candidates
                  .filter((c) => !items.some((i) => i.variantId === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </Select>
              <Input
                label={t('catalogue.quantity')}
                type="number"
                min="0.0001"
                step="0.0001"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-28"
                data-testid="bundle-quantity"
              />
              <Button
                variant="secondary"
                disabled={!candidate}
                onClick={() => {
                  setItems([...items, { variantId: candidate, quantity: quantity || '1' }]);
                  setCandidate('');
                  setQuantity('1');
                }}
                data-testid="bundle-add"
              >
                {t('common.add')}
              </Button>
            </div>

            <div className="flex gap-2">
              <Button
                loading={save.isPending}
                disabled={save.isPending || items.length === 0}
                onClick={() => save.mutate()}
                data-testid="save-bundle"
              >
                {t('common.save')}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={save.isPending}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
