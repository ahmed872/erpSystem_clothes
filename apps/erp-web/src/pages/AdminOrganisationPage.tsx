import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, ConfirmDialog, DataTable, ErrorBanner, Input, Select, Tabs } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { describeError } from '../lib/apiClient';
import { branchTone, warehouseTone } from '../lib/admin';
import { usePermission } from '../hooks/usePermission';
import type { AdminBranch, AdminWarehouse } from '../lib/apiTypes';

/**
 * Phase 20 — BRANCHES AND WAREHOUSES.
 *
 * NEITHER CAN BE DELETED. There is no DELETE route for a branch or a
 * warehouse anywhere in the contract, and that is right: every sale,
 * movement and stock balance ever written names one. So the only lever
 * is `isActive`, and it is REVERSIBLE — unlike a customer, which Phase 18
 * found could be deactivated and never brought back. This screen says
 * "deactivate", offers "reactivate", and never says "delete".
 *
 * THE BRANCH LIST RETURNS ACTIVE AND INACTIVE. `?isActive` is accepted
 * and ignored by the server, so no state filter is offered — an inert
 * control is worse than an absent one. Both tabs show everything and mark
 * the inactive rows.
 *
 * `isDefault` IS SCOPED TO A BRANCH, not to the business: setting one
 * clears the previous default OF THAT SAME BRANCH, server-side. So
 * warehouses are grouped by branch and each group shows its own default,
 * and the browser never clears a flag itself.
 *
 * A WAREHOUSE HOLDING STOCK CAN STILL BE DEACTIVATED — the server does
 * not block it. The confirmation says so rather than implying a check
 * that does not exist.
 */
export function AdminOrganisationPage() {
  const { t } = useTranslation();
  const canViewBranches = usePermission('branches.view');
  const canViewWarehouses = usePermission('warehouses.view');

  const tabs = [
    ...(canViewBranches ? [{ id: 'branches', label: t('admin.org.branches') }] : []),
    ...(canViewWarehouses ? [{ id: 'warehouses', label: t('admin.org.warehouses') }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.id ?? '');

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('admin.org.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('admin.org.explainer')}</p>

      <Tabs data-testid="org-tabs" active={tab} onChange={setTab} tabs={tabs}>
        {tab === 'branches' && <BranchesTab />}
        {tab === 'warehouses' && <WarehousesTab />}
      </Tabs>
    </div>
  );
}

// ====================================================================
function BranchesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canCreate = usePermission('branches.create');
  const canEdit = usePermission('branches.edit');

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminBranch | null>(null);
  const [toggling, setToggling] = useState<AdminBranch | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const branches = useQuery({ queryKey: ['admin-branches'], queryFn: () => adminApi.listBranches() });

  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }
  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['admin-branches'] });
    await queryClient.invalidateQueries({ queryKey: ['admin-warehouses'] });
  }

  const toggle = useMutation({
    mutationFn: () => adminApi.updateBranch(toggling!.id, { isActive: !toggling!.isActive }),
    onSuccess: async () => {
      const wasActive = toggling!.isActive;
      setToggling(null);
      await refresh(t(wasActive ? 'admin.org.branchDeactivated' : 'admin.org.branchReactivated'));
    },
    onError: (e) => {
      setToggling(null);
      fail(e);
    },
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500" data-testid="branches-hint">
          {t('admin.org.branchesHint')}
        </p>
        {canCreate && (
          <Button size="sm" onClick={() => setCreating(true)} data-testid="new-branch">
            {t('admin.org.newBranch')}
          </Button>
        )}
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="branches-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}
      {branches.isError && <ErrorBanner {...describeError(branches.error)} />}

      <DataTable
        data-testid="branches-table"
        loading={branches.isLoading}
        rows={branches.data?.data ?? []}
        rowKey={(b) => b.id}
        empty={t('admin.org.noBranches')}
        columns={[
          { key: 'name', header: t('admin.org.name'), cell: (b: AdminBranch) => b.name },
          { key: 'address', header: t('admin.org.address'), cell: (b) => b.address ?? '—' },
          { key: 'phone', header: t('admin.org.phone'), className: 'numeric', cell: (b) => b.phone ?? '—' },
          {
            key: 'state',
            header: t('admin.org.state'),
            cell: (b) => <Badge tone={branchTone(b)}>{t(b.isActive ? 'admin.org.active' : 'admin.org.inactive')}</Badge>,
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (b) => (
              <div className="flex flex-wrap justify-end gap-1">
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(b)} data-testid={`edit-branch-${b.id}`}>
                    {t('common.edit')}
                  </Button>
                )}
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setToggling(b)} data-testid={`toggle-branch-${b.id}`}>
                    {t(b.isActive ? 'admin.org.deactivate' : 'admin.org.reactivate')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      {(creating || editing) && (
        <BranchDialog
          branch={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onError={fail}
          onSaved={async () => {
            const wasEditing = Boolean(editing);
            setCreating(false);
            setEditing(null);
            await refresh(t(wasEditing ? 'admin.org.branchUpdated' : 'admin.org.branchCreated'));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(toggling)}
        tone={toggling?.isActive ? 'danger' : 'primary'}
        title={t(toggling?.isActive ? 'admin.org.deactivateBranchTitle' : 'admin.org.reactivateBranchTitle')}
        message={t(toggling?.isActive ? 'admin.org.deactivateBranchWarning' : 'admin.org.reactivateBranchWarning')}
        confirmLabel={t(toggling?.isActive ? 'admin.org.deactivate' : 'admin.org.reactivate')}
        cancelLabel={t('common.cancel')}
        pending={toggle.isPending}
        onConfirm={() => toggle.mutate()}
        onClose={() => setToggling(null)}
        data-testid="toggle-branch-dialog"
      />
    </div>
  );
}

function BranchDialog({
  branch,
  onClose,
  onSaved,
  onError,
}: {
  branch: AdminBranch | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: branch?.name ?? '', address: branch?.address ?? '', phone: branch?.phone ?? '' });

  const body = () => ({
    name: form.name.trim(),
    ...(form.address.trim() ? { address: form.address.trim() } : {}),
    ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
  });
  const save = useMutation({
    mutationFn: () => (branch ? adminApi.updateBranch(branch.id, body()) : adminApi.createBranch(body())),
    onSuccess: onSaved,
    onError,
  });

  return (
    <ConfirmDialog
      open
      title={t(branch ? 'admin.org.editBranch' : 'admin.org.newBranch')}
      confirmLabel={t(branch ? 'common.save' : 'common.create')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="branch-dialog"
    >
      <Input label={t('admin.org.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="branch-name" />
      <Input
        label={t('admin.org.address')}
        value={form.address}
        onChange={(e) => setForm({ ...form, address: e.target.value })}
        data-testid="branch-address"
      />
      <Input label={t('admin.org.phone')} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} data-testid="branch-phone" />
    </ConfirmDialog>
  );
}

// ====================================================================
function WarehousesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canCreate = usePermission('warehouses.create');
  const canEdit = usePermission('warehouses.edit');
  const canViewBranches = usePermission('branches.view');

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminWarehouse | null>(null);
  const [toggling, setToggling] = useState<AdminWarehouse | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const warehouses = useQuery({ queryKey: ['admin-warehouses'], queryFn: () => adminApi.listWarehouses() });
  const branches = useQuery({ queryKey: ['admin-branches'], queryFn: () => adminApi.listBranches(), enabled: canViewBranches });
  const branchName = (id: string) => branches.data?.data.find((b) => b.id === id)?.name ?? id;

  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }
  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['admin-warehouses'] });
  }

  const toggle = useMutation({
    mutationFn: () => adminApi.updateWarehouse(toggling!.id, { isActive: !toggling!.isActive }),
    onSuccess: async () => {
      const wasActive = toggling!.isActive;
      setToggling(null);
      await refresh(t(wasActive ? 'admin.org.warehouseDeactivated' : 'admin.org.warehouseReactivated'));
    },
    onError: (e) => {
      setToggling(null);
      fail(e);
    },
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500" data-testid="warehouses-hint">
          {t('admin.org.warehousesHint')}
        </p>
        {canCreate && canViewBranches && (
          <Button size="sm" onClick={() => setCreating(true)} data-testid="new-warehouse">
            {t('admin.org.newWarehouse')}
          </Button>
        )}
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="warehouses-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}
      {warehouses.isError && <ErrorBanner {...describeError(warehouses.error)} />}

      <DataTable
        data-testid="warehouses-table"
        loading={warehouses.isLoading}
        rows={warehouses.data?.data ?? []}
        rowKey={(w) => w.id}
        empty={t('admin.org.noWarehouses')}
        columns={[
          { key: 'name', header: t('admin.org.name'), cell: (w: AdminWarehouse) => w.name },
          { key: 'branch', header: t('admin.org.branch'), cell: (w) => branchName(w.branchId) },
          {
            key: 'default',
            header: t('admin.org.default'),
            cell: (w) => (w.isDefault ? <Badge tone="brand">{t('admin.org.defaultFor')}</Badge> : '—'),
          },
          {
            key: 'state',
            header: t('admin.org.state'),
            cell: (w) => <Badge tone={warehouseTone(w)}>{t(w.isActive ? 'admin.org.active' : 'admin.org.inactive')}</Badge>,
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (w) => (
              <div className="flex flex-wrap justify-end gap-1">
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(w)} data-testid={`edit-warehouse-${w.id}`}>
                    {t('common.edit')}
                  </Button>
                )}
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setToggling(w)} data-testid={`toggle-warehouse-${w.id}`}>
                    {t(w.isActive ? 'admin.org.deactivate' : 'admin.org.reactivate')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      {(creating || editing) && (
        <WarehouseDialog
          warehouse={editing}
          branches={branches.data?.data ?? []}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onError={fail}
          onSaved={async () => {
            const wasEditing = Boolean(editing);
            setCreating(false);
            setEditing(null);
            await refresh(t(wasEditing ? 'admin.org.warehouseUpdated' : 'admin.org.warehouseCreated'));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(toggling)}
        tone={toggling?.isActive ? 'danger' : 'primary'}
        title={t(toggling?.isActive ? 'admin.org.deactivateWarehouseTitle' : 'admin.org.reactivateWarehouseTitle')}
        message={t(toggling?.isActive ? 'admin.org.deactivateWarehouseWarning' : 'admin.org.reactivateWarehouseWarning')}
        confirmLabel={t(toggling?.isActive ? 'admin.org.deactivate' : 'admin.org.reactivate')}
        cancelLabel={t('common.cancel')}
        pending={toggle.isPending}
        onConfirm={() => toggle.mutate()}
        onClose={() => setToggling(null)}
        data-testid="toggle-warehouse-dialog"
      />
    </div>
  );
}

function WarehouseDialog({
  warehouse,
  branches,
  onClose,
  onSaved,
  onError,
}: {
  warehouse: AdminWarehouse | null;
  branches: AdminBranch[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(warehouse?.name ?? '');
  const [branchId, setBranchId] = useState(warehouse?.branchId ?? branches[0]?.id ?? '');
  const [isDefault, setIsDefault] = useState(warehouse?.isDefault ?? false);

  const save = useMutation({
    mutationFn: () =>
      warehouse
        ? adminApi.updateWarehouse(warehouse.id, { name: name.trim(), isDefault })
        : adminApi.createWarehouse({ branchId, name: name.trim(), isDefault }),
    onSuccess: onSaved,
    onError,
  });

  return (
    <ConfirmDialog
      open
      title={t(warehouse ? 'admin.org.editWarehouse' : 'admin.org.newWarehouse')}
      confirmLabel={t(warehouse ? 'common.save' : 'common.create')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="warehouse-dialog"
    >
      <Input label={t('admin.org.name')} value={name} onChange={(e) => setName(e.target.value)} data-testid="warehouse-name" />
      {warehouse ? (
        // `updateWarehouseSchema` accepts no branchId: a warehouse does
        // not move between branches, because its stock would move with it.
        <p className="text-xs text-neutral-500" data-testid="warehouse-branch-fixed">
          {t('admin.org.branchFixed')}
        </p>
      ) : (
        <Select label={t('admin.org.branch')} value={branchId} onChange={(e) => setBranchId(e.target.value)} data-testid="warehouse-branch">
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      )}
      <label className="mt-1 flex items-center gap-2 text-xs text-neutral-700">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} data-testid="warehouse-default" />
        {t('admin.org.makeDefault')}
      </label>
      <p className="text-xs text-neutral-500">{t('admin.org.defaultHint')}</p>
    </ConfirmDialog>
  );
}
