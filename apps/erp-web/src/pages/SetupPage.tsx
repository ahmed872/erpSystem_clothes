import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Tabs } from '@retail/ui-kit';
import type { TabDef } from '@retail/ui-kit';
import { referenceApi } from '../api/reference';
import { describeError } from '../lib/apiClient';
import { usePermission } from '../hooks/usePermission';
import type { Attribute, Brand, Category, Tax, Uom } from '../lib/apiTypes';

/**
 * Phase 14 — THE GENERIC MASTER DATA A CATALOGUE IS BUILT FROM.
 *
 * FIVE INDEPENDENT GRANTS BEHIND ONE DESTINATION. Categories, brands,
 * attributes, units and taxes each carry their own view/create/edit codes
 * and the roles genuinely differ: an ACCOUNTANT holds `tax.manage` and
 * none of the other four, while an INVENTORY_MANAGER holds the four and
 * only `tax.view`. So the tab LIST is built from held permissions — the
 * nav entry appears when ANY tab is reachable, and each tab is present
 * only for its own grant.
 *
 * NOTHING HERE IS CLOTHING. A tenant defines its own Attributes: a
 * garment shop creates "Size" and "Colour", an appliance dealer creates
 * "Capacity" and "Voltage", through this same screen. There is no `size`
 * field in the model and none is introduced here — that is what makes
 * this a retail operating system rather than a clothing product.
 *
 * TAX IS CONFIGURED, NOT COMPUTED. This assigns a rate to a named tax;
 * the backend remains sole authority for inclusive/exclusive behaviour
 * and every computed tax amount on a sale.
 */
export function SetupPage() {
  const { t } = useTranslation();

  const canCategories = usePermission('categories.view');
  const canBrands = usePermission('brands.view');
  const canAttributes = usePermission('attributes.view');
  const canUoms = usePermission('uoms.view');
  const canTaxes = usePermission('tax.view');

  const tabs: TabDef[] = [
    ...(canCategories ? [{ id: 'categories', label: t('setup.categories') }] : []),
    ...(canBrands ? [{ id: 'brands', label: t('setup.brands') }] : []),
    ...(canAttributes ? [{ id: 'attributes', label: t('setup.attributes') }] : []),
    ...(canUoms ? [{ id: 'uoms', label: t('setup.uoms') }] : []),
    ...(canTaxes ? [{ id: 'taxes', label: t('setup.taxes') }] : []),
  ];
  const [active, setActive] = useState(tabs[0]?.id ?? '');

  return (
    <div className="mx-auto max-w-5xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('setup.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('setup.explainer')}</p>

      <Tabs tabs={tabs} active={active} onChange={setActive} data-testid="setup-tabs">
        {active === 'categories' && <CategoriesTab />}
        {active === 'brands' && <BrandsTab />}
        {active === 'attributes' && <AttributesTab />}
        {active === 'uoms' && <UomsTab />}
        {active === 'taxes' && <TaxesTab />}
      </Tabs>
    </div>
  );
}

/** Shared frame: a create control, an error slot, and a table. */
function Section({
  title,
  canCreate,
  createLabel,
  onCreate,
  error,
  children,
}: {
  title: string;
  canCreate: boolean;
  createLabel: string;
  onCreate: () => void;
  error: { title: string; message?: string } | null;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardBody className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-neutral-900">{title}</h2>
          {canCreate && (
            <Button size="sm" variant="secondary" onClick={onCreate} data-testid="section-create">
              {createLabel}
            </Button>
          )}
        </div>
        {error && <ErrorBanner title={error.title} message={error.message} />}
        {children}
      </CardBody>
    </Card>
  );
}

function useSectionError() {
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  return { error, report: (e: unknown) => setError(describeError(e)), clear: () => setError(null) };
}

// ---------------------------------------------------------- Categories --
function CategoriesTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canCreate = usePermission('categories.create');
  const canEdit = usePermission('categories.edit');
  const { error, report, clear } = useSectionError();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const list = useQuery({ queryKey: ['categories'], queryFn: () => referenceApi.listCategories() });
  const create = useMutation({
    mutationFn: () => referenceApi.createCategory({ name: name.trim() }),
    onSuccess: async () => {
      setCreating(false);
      setName('');
      clear();
      await qc.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: report,
  });
  const toggle = useMutation({
    mutationFn: (c: Category) => referenceApi.updateCategory(c.id, { isActive: !c.isActive }),
    onSuccess: async () => {
      clear();
      await qc.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: report,
  });

  return (
    <Section
      title={t('setup.categories')}
      canCreate={canCreate}
      createLabel={t('setup.addCategory')}
      onCreate={() => setCreating(true)}
      error={error}
    >
      <DataTable
        data-testid="categories-table"
        loading={list.isLoading}
        rows={list.data?.data ?? []}
        rowKey={(c) => c.id}
        empty={t('setup.noCategories')}
        columns={[
          { key: 'name', header: t('setup.name'), cell: (c: Category) => c.name },
          { key: 'state', header: t('setup.state'), cell: (c) => <ActiveBadge active={c.isActive} /> },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (c) =>
              canEdit ? (
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(c)} data-testid={`toggle-category-${c.name}`}>
                  {c.isActive ? t('setup.deactivate') : t('setup.activate')}
                </Button>
              ) : null,
          },
        ]}
      />
      <NameDialog
        open={creating}
        title={t('setup.addCategory')}
        value={name}
        onChange={setName}
        pending={create.isPending}
        onConfirm={() => create.mutate()}
        onClose={() => setCreating(false)}
        testId="category-dialog"
      />
    </Section>
  );
}

// -------------------------------------------------------------- Brands --
function BrandsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canCreate = usePermission('brands.create');
  const canEdit = usePermission('brands.edit');
  const { error, report, clear } = useSectionError();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const list = useQuery({ queryKey: ['brands'], queryFn: () => referenceApi.listBrands() });
  const create = useMutation({
    mutationFn: () => referenceApi.createBrand({ name: name.trim() }),
    onSuccess: async () => {
      setCreating(false);
      setName('');
      clear();
      await qc.invalidateQueries({ queryKey: ['brands'] });
    },
    onError: report,
  });
  const toggle = useMutation({
    mutationFn: (b: Brand) => referenceApi.updateBrand(b.id, { isActive: !b.isActive }),
    onSuccess: async () => {
      clear();
      await qc.invalidateQueries({ queryKey: ['brands'] });
    },
    onError: report,
  });

  return (
    <Section
      title={t('setup.brands')}
      canCreate={canCreate}
      createLabel={t('setup.addBrand')}
      onCreate={() => setCreating(true)}
      error={error}
    >
      <DataTable
        data-testid="brands-table"
        loading={list.isLoading}
        rows={list.data?.data ?? []}
        rowKey={(b) => b.id}
        empty={t('setup.noBrands')}
        columns={[
          { key: 'name', header: t('setup.name'), cell: (b: Brand) => b.name },
          { key: 'state', header: t('setup.state'), cell: (b) => <ActiveBadge active={b.isActive} /> },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (b) =>
              canEdit ? (
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(b)} data-testid={`toggle-brand-${b.name}`}>
                  {b.isActive ? t('setup.deactivate') : t('setup.activate')}
                </Button>
              ) : null,
          },
        ]}
      />
      <NameDialog
        open={creating}
        title={t('setup.addBrand')}
        value={name}
        onChange={setName}
        pending={create.isPending}
        onConfirm={() => create.mutate()}
        onClose={() => setCreating(false)}
        testId="brand-dialog"
      />
    </Section>
  );
}

// ---------------------------------------------------------- Attributes --
function AttributesTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canCreate = usePermission('attributes.create');
  const canDelete = usePermission('attributes.delete');
  const { error, report, clear } = useSectionError();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [addingTo, setAddingTo] = useState<Attribute | null>(null);
  const [value, setValue] = useState('');
  const [removing, setRemoving] = useState<{ id: string; value: string } | null>(null);

  const list = useQuery({ queryKey: ['attributes'], queryFn: () => referenceApi.listAttributes() });
  const refresh = async () => {
    clear();
    await qc.invalidateQueries({ queryKey: ['attributes'] });
  };

  const create = useMutation({
    mutationFn: () => referenceApi.createAttribute({ name: name.trim() }),
    onSuccess: async () => {
      setCreating(false);
      setName('');
      await refresh();
    },
    onError: report,
  });
  const addValue = useMutation({
    mutationFn: () => referenceApi.createAttributeValue(addingTo!.id, { value: value.trim() }),
    onSuccess: async () => {
      setAddingTo(null);
      setValue('');
      await refresh();
    },
    onError: report,
  });
  const removeValue = useMutation({
    mutationFn: () => referenceApi.deleteAttributeValue(removing!.id),
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
    onError: report,
  });

  return (
    <Section
      title={t('setup.attributes')}
      canCreate={canCreate}
      createLabel={t('setup.addAttribute')}
      onCreate={() => setCreating(true)}
      error={error}
    >
      {/* The generic mechanism, stated in the product: the tenant names
          its own dimensions, whatever it sells. */}
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('setup.attributesExplainer')}</p>

      <div className="flex flex-col gap-2" data-testid="attributes-list">
        {(list.data?.data ?? []).map((attr) => (
          <div key={attr.id} className="rounded-lg border border-neutral-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-neutral-800">{attr.name}</span>
              <div className="flex items-center gap-2">
                <ActiveBadge active={attr.isActive} />
                {canCreate && (
                  <Button size="sm" variant="ghost" onClick={() => setAddingTo(attr)} data-testid={`add-value-${attr.name}`}>
                    {t('setup.addValue')}
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {attr.values.length === 0 && <span className="text-xs text-neutral-400">{t('setup.noValues')}</span>}
              {attr.values.map((v) => (
                <span
                  key={v.id}
                  className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
                >
                  {v.value}
                  {/* The ONE destructive verb in the catalogue contract,
                      and the only place a ConfirmDialog guards a delete
                      rather than a deactivation. */}
                  {canDelete && (
                    <button
                      type="button"
                      className="text-neutral-400 hover:text-danger-600"
                      onClick={() => setRemoving({ id: v.id, value: v.value })}
                      data-testid={`remove-value-${v.value}`}
                      aria-label={t('common.remove')}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
        {(list.data?.data ?? []).length === 0 && !list.isLoading && (
          <p className="p-4 text-center text-sm text-neutral-500">{t('setup.noAttributes')}</p>
        )}
      </div>

      <NameDialog
        open={creating}
        title={t('setup.addAttribute')}
        value={name}
        onChange={setName}
        pending={create.isPending}
        onConfirm={() => create.mutate()}
        onClose={() => setCreating(false)}
        testId="attribute-dialog"
      />
      <NameDialog
        open={Boolean(addingTo)}
        title={t('setup.addValue')}
        value={value}
        onChange={setValue}
        pending={addValue.isPending}
        onConfirm={() => addValue.mutate()}
        onClose={() => setAddingTo(null)}
        testId="value-dialog"
      />
      <ConfirmDialog
        open={Boolean(removing)}
        tone="danger"
        title={t('setup.removeValue')}
        message={t('setup.removeValueWarning', { value: removing?.value ?? '' })}
        confirmLabel={t('common.remove')}
        cancelLabel={t('common.cancel')}
        pending={removeValue.isPending}
        onConfirm={() => removeValue.mutate()}
        onClose={() => setRemoving(null)}
        data-testid="remove-value-dialog"
      />
    </Section>
  );
}

// ---------------------------------------------------------------- UOMs --
function UomsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canCreate = usePermission('uoms.create');
  const canEdit = usePermission('uoms.edit');
  const { error, report, clear } = useSectionError();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const list = useQuery({ queryKey: ['uoms'], queryFn: () => referenceApi.listUoms() });
  const create = useMutation({
    mutationFn: () => referenceApi.createUom({ name: name.trim(), code: code.trim() }),
    onSuccess: async () => {
      setCreating(false);
      setName('');
      setCode('');
      clear();
      await qc.invalidateQueries({ queryKey: ['uoms'] });
    },
    onError: report,
  });
  const toggle = useMutation({
    mutationFn: (u: Uom) => referenceApi.updateUom(u.id, { isActive: !u.isActive }),
    onSuccess: async () => {
      clear();
      await qc.invalidateQueries({ queryKey: ['uoms'] });
    },
    onError: report,
  });

  return (
    <Section
      title={t('setup.uoms')}
      canCreate={canCreate}
      createLabel={t('setup.addUom')}
      onCreate={() => setCreating(true)}
      error={error}
    >
      <DataTable
        data-testid="uoms-table"
        loading={list.isLoading}
        rows={list.data?.data ?? []}
        rowKey={(u) => u.id}
        empty={t('setup.noUoms')}
        columns={[
          { key: 'name', header: t('setup.name'), cell: (u: Uom) => u.name },
          { key: 'code', header: t('setup.code'), className: 'numeric', cell: (u) => u.code },
          { key: 'precision', header: t('setup.precision'), align: 'end', className: 'numeric', cell: (u) => String(u.precision) },
          { key: 'state', header: t('setup.state'), cell: (u) => <ActiveBadge active={u.isActive} /> },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (u) =>
              canEdit ? (
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(u)} data-testid={`toggle-uom-${u.code}`}>
                  {u.isActive ? t('setup.deactivate') : t('setup.activate')}
                </Button>
              ) : null,
          },
        ]}
      />
      <ConfirmDialog
        open={creating}
        title={t('setup.addUom')}
        confirmLabel={t('common.create')}
        cancelLabel={t('common.cancel')}
        pending={create.isPending}
        onConfirm={() => create.mutate()}
        onClose={() => setCreating(false)}
        data-testid="uom-dialog"
      >
        <Input label={t('setup.name')} value={name} onChange={(e) => setName(e.target.value)} data-testid="uom-name" />
        <Input label={t('setup.code')} value={code} onChange={(e) => setCode(e.target.value)} data-testid="uom-code" />
      </ConfirmDialog>
    </Section>
  );
}

// --------------------------------------------------------------- Taxes --
function TaxesTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canManage = usePermission('tax.manage');
  const { error, report, clear } = useSectionError();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');

  const list = useQuery({ queryKey: ['taxes'], queryFn: () => referenceApi.listTaxes() });
  const create = useMutation({
    mutationFn: () => referenceApi.createTax({ name: name.trim(), ratePercent: Number(rate) }),
    onSuccess: async () => {
      setCreating(false);
      setName('');
      setRate('');
      clear();
      await qc.invalidateQueries({ queryKey: ['taxes'] });
    },
    onError: report,
  });
  const toggle = useMutation({
    mutationFn: (x: Tax) => referenceApi.updateTax(x.id, { isActive: !x.isActive }),
    onSuccess: async () => {
      clear();
      await qc.invalidateQueries({ queryKey: ['taxes'] });
    },
    onError: report,
  });

  return (
    <Section
      title={t('setup.taxes')}
      canCreate={canManage}
      createLabel={t('setup.addTax')}
      onCreate={() => setCreating(true)}
      error={error}
    >
      {/* The rate is configured here; every computed tax amount, and the
          inclusive/exclusive mode, remain the backend's. */}
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('setup.taxesExplainer')}</p>
      <DataTable
        data-testid="taxes-table"
        loading={list.isLoading}
        rows={list.data?.data ?? []}
        rowKey={(x) => x.id}
        empty={t('setup.noTaxes')}
        columns={[
          { key: 'name', header: t('setup.name'), cell: (x: Tax) => x.name },
          { key: 'rate', header: t('setup.rate'), align: 'end', className: 'numeric', cell: (x) => `${x.ratePercent}%` },
          { key: 'state', header: t('setup.state'), cell: (x) => <ActiveBadge active={x.isActive} /> },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (x) =>
              canManage ? (
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(x)} data-testid={`toggle-tax-${x.name}`}>
                  {x.isActive ? t('setup.deactivate') : t('setup.activate')}
                </Button>
              ) : null,
          },
        ]}
      />
      <ConfirmDialog
        open={creating}
        title={t('setup.addTax')}
        confirmLabel={t('common.create')}
        cancelLabel={t('common.cancel')}
        pending={create.isPending}
        onConfirm={() => create.mutate()}
        onClose={() => setCreating(false)}
        data-testid="tax-dialog"
      >
        <Input label={t('setup.name')} value={name} onChange={(e) => setName(e.target.value)} data-testid="tax-name" />
        <Input
          label={t('setup.rate')}
          type="number"
          min="0"
          step="0.01"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          data-testid="tax-rate"
        />
      </ConfirmDialog>
    </Section>
  );
}

// ---------------------------------------------------------------------
function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useTranslation();
  return <Badge tone={active ? 'success' : 'neutral'}>{t(active ? 'setup.activeLabel' : 'setup.inactiveLabel')}</Badge>;
}

function NameDialog({
  open,
  title,
  value,
  onChange,
  pending,
  onConfirm,
  onClose,
  testId,
}: {
  open: boolean;
  title: string;
  value: string;
  onChange: (v: string) => void;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={t('common.create')}
      cancelLabel={t('common.cancel')}
      pending={pending}
      onConfirm={onConfirm}
      onClose={onClose}
      data-testid={testId}
    >
      <Input label={t('setup.name')} value={value} onChange={(e) => onChange(e.target.value)} data-testid={`${testId}-input`} />
    </ConfirmDialog>
  );
}
