import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, ErrorBanner, Input, Select, Spinner } from '@retail/ui-kit';
import { catalogApi } from '../api/catalog';
import { referenceApi } from '../api/reference';
import { describeError } from '../lib/apiClient';
import { usePermission } from '../hooks/usePermission';
import type { ProductType } from '../lib/apiTypes';

/**
 * Phase 14 — CREATING A PRODUCT.
 *
 * The form mirrors `createProductSchema` and adds no rule of its own. In
 * particular the two things that LOOK like frontend validation are not:
 * a BUNDLE must have at least one component and a SIMPLE one must have
 * none — both are `.refine()` clauses on the live schema, and the server
 * rejects a violation with a 422 whatever this form does. The controls
 * below simply avoid offering a shape that must be refused.
 *
 * `defaultCost` and `defaultSellingPrice` are CREATION-TIME SEEDS. They
 * populate the auto-generated first variant and are then not
 * independently editable — the operational figures live on the variant,
 * behind `products.change_cost` and `products.change_price`. That is the
 * backend's documented design decision, not a limitation of this screen.
 *
 * The cost field is offered only to a caller who may see cost at all;
 * `products.create` and `products.view_cost` are separate grants.
 */
export function ProductCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canSeeCost = usePermission('products.view_cost');
  const canSeeTaxes = usePermission('tax.view');
  const canSeeCategories = usePermission('categories.view');
  const canSeeBrands = usePermission('brands.view');

  const [form, setForm] = useState({
    sku: '',
    name: '',
    alternativeName: '',
    type: 'SIMPLE' as ProductType,
    baseUomId: '',
    categoryId: '',
    brandId: '',
    taxId: '',
    taxExempt: false,
    defaultCost: '0',
    defaultSellingPrice: '0',
    tracksLots: false,
    tracksSerialNumbers: false,
  });
  const [components, setComponents] = useState<{ variantId: string; quantity: string }[]>([]);
  const [candidate, setCandidate] = useState('');
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  const uoms = useQuery({ queryKey: ['uoms'], queryFn: () => referenceApi.listUoms() });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => referenceApi.listCategories(), enabled: canSeeCategories });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => referenceApi.listBrands(), enabled: canSeeBrands });
  const taxes = useQuery({ queryKey: ['taxes'], queryFn: () => referenceApi.listTaxes(), enabled: canSeeTaxes });
  const candidates = useQuery({
    queryKey: ['products', 'bundle-candidates'],
    queryFn: () => catalogApi.listProducts({ type: 'SIMPLE', status: 'ACTIVE', limit: 100 }),
    enabled: form.type === 'BUNDLE',
  });

  const create = useMutation({
    mutationFn: () =>
      catalogApi.createProduct({
        sku: form.sku.trim(),
        name: form.name.trim(),
        ...(form.alternativeName.trim() ? { alternativeName: form.alternativeName.trim() } : {}),
        type: form.type,
        baseUomId: form.baseUomId,
        ...(form.categoryId ? { categoryId: form.categoryId } : {}),
        ...(form.brandId ? { brandId: form.brandId } : {}),
        ...(form.taxExempt ? { taxExempt: true } : form.taxId ? { taxId: form.taxId } : {}),
        defaultCost: Number(form.defaultCost || 0),
        defaultSellingPrice: Number(form.defaultSellingPrice || 0),
        tracksLots: form.tracksLots,
        tracksSerialNumbers: form.tracksSerialNumbers,
        ...(form.type === 'BUNDLE'
          ? { bundleItems: components.map((c) => ({ variantId: c.variantId, quantity: Number(c.quantity) })) }
          : {}),
      }),
    onSuccess: (res) => navigate(`/catalogue/${res.data.id}`),
    onError: (err) => setError(describeError(err)),
  });

  const variantOptions = (candidates.data?.data ?? []).flatMap((p) =>
    p.variants.filter((v) => v.status === 'ACTIVE').map((v) => ({ id: v.id, label: `${p.name} · ${v.sku}` })),
  );

  if (uoms.isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('catalogue.newProduct')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('catalogue.newProductExplainer')}</p>

      {error && <ErrorBanner title={error.title} message={error.message} />}

      <Card>
        <CardBody className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          <Input
            label={t('catalogue.sku')}
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })}
            data-testid="create-sku"
          />
          <Input
            label={t('catalogue.name')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            data-testid="create-name"
          />
          <Input
            label={t('catalogue.alternativeName')}
            value={form.alternativeName}
            onChange={(e) => setForm({ ...form, alternativeName: e.target.value })}
          />
          <Select
            label={t('catalogue.type')}
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as ProductType })}
            data-testid="create-type"
          >
            <option value="SIMPLE">{t('catalogue.typeLabel.SIMPLE')}</option>
            <option value="BUNDLE">{t('catalogue.typeLabel.BUNDLE')}</option>
          </Select>
          <Select
            label={t('catalogue.baseUom')}
            value={form.baseUomId}
            onChange={(e) => setForm({ ...form, baseUomId: e.target.value })}
            data-testid="create-uom"
          >
            <option value="">{t('catalogue.selectUom')}</option>
            {(uoms.data?.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.code})
              </option>
            ))}
          </Select>
          {canSeeCategories && (
            <Select
              label={t('catalogue.category')}
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
            >
              <option value="">{t('catalogue.none')}</option>
              {(categories.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
          {canSeeBrands && (
            <Select label={t('catalogue.brand')} value={form.brandId} onChange={(e) => setForm({ ...form, brandId: e.target.value })}>
              <option value="">{t('catalogue.none')}</option>
              {(brands.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
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
            >
              <option value="">{t('catalogue.taxBusinessDefault')}</option>
              {(taxes.data?.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {x.ratePercent}%
                </option>
              ))}
              <option value="EXEMPT">{t('catalogue.taxExempt')}</option>
            </Select>
          )}
          <Input
            label={t('catalogue.defaultPrice')}
            type="number"
            min="0"
            step="0.0001"
            value={form.defaultSellingPrice}
            onChange={(e) => setForm({ ...form, defaultSellingPrice: e.target.value })}
            data-testid="create-price"
          />
          {/* Offered only to a caller entitled to see cost at all. */}
          {canSeeCost && (
            <Input
              label={t('catalogue.defaultCost')}
              type="number"
              min="0"
              step="0.0001"
              value={form.defaultCost}
              onChange={(e) => setForm({ ...form, defaultCost: e.target.value })}
              data-testid="create-cost"
            />
          )}

          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={form.tracksLots}
              onChange={(e) => setForm({ ...form, tracksLots: e.target.checked })}
            />
            {t('catalogue.tracksLots')}
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={form.tracksSerialNumbers}
              onChange={(e) => setForm({ ...form, tracksSerialNumbers: e.target.checked })}
              data-testid="create-serials"
            />
            {t('catalogue.tracksSerials')}
          </label>

          {/* A BUNDLE requires at least one component — the schema's own
              refine, mirrored so the form cannot submit a certain 422. */}
          {form.type === 'BUNDLE' && (
            <div className="sm:col-span-2">
              <p className="mb-1 text-sm font-semibold text-neutral-800">{t('catalogue.bundleComposition')}</p>
              <p className="mb-2 text-xs text-neutral-500">{t('catalogue.bundleExplainer')}</p>
              {components.map((c, idx) => (
                <div key={c.variantId} className="mb-1 flex items-center gap-2 rounded-lg border border-neutral-200 p-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {variantOptions.find((v) => v.id === c.variantId)?.label ?? c.variantId}
                  </span>
                  <Input
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    value={c.quantity}
                    onChange={(e) => {
                      const next = [...components];
                      next[idx] = { ...c, quantity: e.target.value };
                      setComponents(next);
                    }}
                    className="w-24"
                  />
                  <Button size="sm" variant="ghost" onClick={() => setComponents(components.filter((_, i) => i !== idx))}>
                    {t('common.remove')}
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-end gap-2">
                <Select value={candidate} onChange={(e) => setCandidate(e.target.value)} data-testid="create-bundle-candidate">
                  <option value="">{t('catalogue.selectVariant')}</option>
                  {variantOptions
                    .filter((v) => !components.some((c) => c.variantId === v.id))
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                </Select>
                <Button
                  variant="secondary"
                  disabled={!candidate}
                  onClick={() => {
                    setComponents([...components, { variantId: candidate, quantity: '1' }]);
                    setCandidate('');
                  }}
                  data-testid="create-bundle-add"
                >
                  {t('common.add')}
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-2 sm:col-span-2">
            <Button
              loading={create.isPending}
              disabled={
                create.isPending ||
                !form.sku.trim() ||
                !form.name.trim() ||
                !form.baseUomId ||
                (form.type === 'BUNDLE' && components.length === 0)
              }
              onClick={() => {
                setError(null);
                create.mutate();
              }}
              data-testid="create-submit"
            >
              {t('catalogue.createProduct')}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/catalogue')} disabled={create.isPending}>
              {t('common.cancel')}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
