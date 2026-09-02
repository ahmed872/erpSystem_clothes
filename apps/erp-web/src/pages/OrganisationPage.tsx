import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Select, Tabs } from '@retail/ui-kit';
import type { TabDef } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { describeError } from '../lib/apiClient';
import { branchNameById, branchTone, warehouseTone } from '../lib/admin';
import { usePermission } from '../hooks/usePermission';
import type { Branch, Warehouse } from '../lib/apiTypes';

/**
 * Phase 20 — THE SHAPE OF THE BUSINESS: branches, and the warehouses
 * inside them.
 *
 * TWO INDEPENDENT GRANTS BEHIND ONE DESTINATION, exactly as reference data
 * is: `branches.*` and `warehouses.*` are separate codes and a role may
 * hold either. So the tab LIST is built from held permissions and each tab
 * re-checks its own — the nav entry appears when either is reachable.
 *
 * NOTHING IS DELETED HERE, because the contract has no DELETE for either.
 * Both deactivate through their PATCH (`isActive: false`), which is the
 * honest verb: a branch with a year of sales behind it cannot be removed
 * without taking the history with it.
 *
 * A WAREHOUSE'S BRANCH IS FIXED AFTER CREATION. `PATCH /warehouses/:id`
 * takes `name`, `isDefault` and `isActive` — no `branchId` — so the branch
 * picker appears on create and is shown read-only on edit rather than
 * offering a move the server would ignore.
 */
export function OrganisationPage() {
  const { t } = useTranslation();
  const canBranches = usePermission('branches.view');
  const canWarehouses = usePermission('warehouses.view');

  const tabs: TabDef[] = [
    ...(canBranches ? [{ id: 'branches', label: t('organisation.branches') }] : []),
    ...(canWarehouses ? [{ id: 'warehouses', label: t('organisation.warehouses') }] : []),
  ];
  const [active, setActive] = useState(tabs[0]?.id ?? '');

  return (
    <div className="mx-auto max-w-5xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('organisation.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('organisation.explainer')}</p>

      <Tabs tabs={tabs} active={active} onChange={setActive} data-testid="organisation-tabs">
        {active === 'branches' && <BranchesTab />}
        {active === 'warehouses' && <WarehousesTab canSeeBranches={canBranches} />}
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
  const [editing, setEditing] = useState<Branch | null>(null);
  const [deactivating, setDeactivating] = useState<Branch | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  const branches = useQuery({ queryKey: ['admin', 'branches'], queryFn: () => adminApi.listBranches() });

  async function refresh() {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['admin', 'branches'] });
  }

  const setActive = useMutation({
    mutationFn: ({ branch, isActive }: { branch: Branch; isActive: boolean }) =>
      adminApi.updateBranch(branch.id, { isActive }),
    onSuccess: async () => {
      setDeactivating(null);
      await refresh();
    },
    onError: (e) => {
      setDeactivating(null);
      setError(describeError(e));
    },
  });

  return (
    <Card>
      <CardBody className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-neutral-900">{t('organisation.branches')}</h2>
          {canCreate && (
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)} data-testid="new-branch">
              {t('organisation.newBranch')}
            </Button>
          )}
        </div>

        {error && <ErrorBanner title={error.title} message={error.message} />}
        {branches.isError && <ErrorBanner {...describeError(branches.error)} />}

        <DataTable
          data-testid="branches-table"
          loading={branches.isLoading}
          rows={branches.data?.data ?? []}
          rowKey={(b) => b.id}
          empty={t('organisation.noBranches')}
          columns={[
            { key: 'name', header: t('organisation.branchName'), cell: (b: Branch) => b.name },
            { key: 'address', header: t('organisation.address'), cell: (b) => b.address ?? '—' },
            { key: 'phone', header: t('organisation.phone'), className: 'numeric', cell: (b) => b.phone ?? '—' },
            {
              key: 'state',
              header: t('organisation.state'),
              cell: (b) => (
                <Badge tone={branchTone(b)}>{t(b.isActive ? 'organisation.active' : 'organisation.inactive')}</Badge>
              ),
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              cell: (b) =>
                canEdit ? (
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(b)} data-testid={`edit-branch-${b.id}`}>
                      {t('common.edit')}
                    </Button>
                    {b.isActive ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeactivating(b)}
                        data-testid={`deactivate-branch-${b.id}`}
                      >
                        {t('organisation.deactivate')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={setActive.isPending}
                        onClick={() => setActive.mutate({ branch: b, isActive: true })}
                        data-testid={`activate-branch-${b.id}`}
                      >
                        {t('organisation.activate')}
                      </Button>
                    )}
                  </div>
                ) : null,
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
            onError={(e) => setError(describeError(e))}
            onSaved={async () => {
              setCreating(false);
              setEditing(null);
              await refresh();
            }}
          />
        )}

        <ConfirmDialog
          open={Boolean(deactivating)}
          tone="danger"
          title={t('organisation.deactivateBranchTitle')}
          message={t('organisation.deactivateBranchWarning')}
          confirmLabel={t('organisation.deactivate')}
          cancelLabel={t('common.cancel')}
          pending={setActive.isPending}
          onConfirm={() => setActive.mutate({ branch: deactivating!, isActive: false })}
          onClose={() => setDeactivating(null)}
          data-testid="deactivate-branch-dialog"
        />
      </CardBody>
    </Card>
  );
}

function BranchDialog({
  branch,
  onClose,
  onSaved,
  onError,
}: {
  branch: Branch | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: branch?.name ?? '',
    address: branch?.address ?? '',
    phone: branch?.phone ?? '',
  });

  // Optional fields are omitted when blank rather than sent as '': the
  // schema types them `.optional()`, not `.nullable()`.
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
      title={t(branch ? 'organisation.editBranch' : 'organisation.newBranch')}
      confirmLabel={t(branch ? 'common.save' : 'common.create')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="branch-dialog"
    >
      <Input
        label={t('organisation.branchName')}
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        data-testid="branch-name"
      />
      <Input
        label={t('organisation.address')}
        value={form.address}
        onChange={(e) => setForm({ ...form, address: e.target.value })}
        data-testid="branch-address"
      />
      <Input
        label={t('organisation.phone')}
        value={form.phone}
        onChange={(e) => setForm({ ...form, phone: e.target.value })}
        data-testid="branch-phone"
      />
    </ConfirmDialog>
  );
}

// ====================================================================
function WarehousesTab({ canSeeBranches }: { canSeeBranches: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canCreate = usePermission('warehouses.create');
  const canEdit = usePermission('warehouses.edit');

  const [branchFilter, setBranchFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  // The branch filter is the SERVER'S: `GET /warehouses?branchId=` is in
  // the contract, so it is used rather than filtering a fetched list.
  const warehouses = useQuery({
    queryKey: ['admin', 'warehouses', branchFilter],
    queryFn: () => adminApi.listWarehouses(branchFilter || undefined),
  });
  const branches = useQuery({
    queryKey: ['admin', 'branches'],
    queryFn: () => adminApi.listBranches(),
    enabled: canSeeBranches,
  });
  const branchList = branches.data?.data ?? [];

  async function refresh() {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['admin', 'warehouses'] });
  }

  const setActive = useMutation({
    mutationFn: ({ warehouse, isActive }: { warehouse: Warehouse; isActive: boolean }) =>
      adminApi.updateWarehouse(warehouse.id, { isActive }),
    onSuccess: refresh,
    onError: (e) => setError(describeError(e)),
  });

  return (
    <Card>
      <CardBody className="p-4">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-sm font-bold text-neutral-900">{t('organisation.warehouses')}</h2>
          <div className="flex flex-wrap items-end gap-2">
            {canSeeBranches && (
              <Select
                label={t('organisation.branch')}
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                data-testid="warehouse-branch-filter"
              >
                <option value="">{t('organisation.allBranches')}</option>
                {branchList.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
            {canCreate && canSeeBranches && (
              <Button size="sm" variant="secondary" onClick={() => setCreating(true)} data-testid="new-warehouse">
                {t('organisation.newWarehouse')}
              </Button>
            )}
          </div>
        </div>

        {error && <ErrorBanner title={error.title} message={error.message} />}
        {warehouses.isError && <ErrorBanner {...describeError(warehouses.error)} />}
        {canCreate && !canSeeBranches && (
          <p className="mb-2 text-xs text-neutral-500" data-testid="warehouse-needs-branches">
            {t('organisation.needsBranchesToCreate')}
          </p>
        )}

        <DataTable
          data-testid="warehouses-table"
          loading={warehouses.isLoading}
          rows={warehouses.data?.data ?? []}
          rowKey={(w) => w.id}
          empty={t('organisation.noWarehouses')}
          columns={[
            { key: 'name', header: t('organisation.warehouseName'), cell: (w: Warehouse) => w.name },
            {
              key: 'branch',
              header: t('organisation.branch'),
              cell: (w) => branchNameById(branchList, w.branchId) ?? '—',
            },
            {
              key: 'default',
              header: t('organisation.defaultWarehouse'),
              cell: (w) => (w.isDefault ? <Badge tone="brand">{t('common.yes')}</Badge> : <span>—</span>),
            },
            {
              key: 'state',
              header: t('organisation.state'),
              cell: (w) => (
                <Badge tone={warehouseTone(w)}>{t(w.isActive ? 'organisation.active' : 'organisation.inactive')}</Badge>
              ),
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              cell: (w) =>
                canEdit ? (
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(w)}
                      data-testid={`edit-warehouse-${w.id}`}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={setActive.isPending}
                      onClick={() => setActive.mutate({ warehouse: w, isActive: !w.isActive })}
                      data-testid={`toggle-warehouse-${w.id}`}
                    >
                      {t(w.isActive ? 'organisation.deactivate' : 'organisation.activate')}
                    </Button>
                  </div>
                ) : null,
            },
          ]}
        />

        {(creating || editing) && (
          <WarehouseDialog
            warehouse={editing}
            branches={branchList}
            onClose={() => {
              setCreating(false);
              setEditing(null);
            }}
            onError={(e) => setError(describeError(e))}
            onSaved={async () => {
              setCreating(false);
              setEditing(null);
              await refresh();
            }}
          />
        )}
      </CardBody>
    </Card>
  );
}

function WarehouseDialog({
  warehouse,
  branches,
  onClose,
  onSaved,
  onError,
}: {
  warehouse: Warehouse | null;
  branches: Branch[];
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
      title={t(warehouse ? 'organisation.editWarehouse' : 'organisation.newWarehouse')}
      confirmLabel={t(warehouse ? 'common.save' : 'common.create')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="warehouse-dialog"
    >
      <Input
        label={t('organisation.warehouseName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        data-testid="warehouse-name"
      />
      {warehouse ? (
        // The contract has no `branchId` on the update, so this is stated
        // rather than offered.
        <Input
          label={t('organisation.branch')}
          value={branches.find((b) => b.id === warehouse.branchId)?.name ?? warehouse.branchId}
          disabled
          hint={t('organisation.branchFixed')}
        />
      ) : (
        <Select
          label={t('organisation.branch')}
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
          data-testid="warehouse-branch"
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      )}
      <label className="flex items-center gap-2 text-sm text-neutral-800">
        <input
          type="checkbox"
          className="h-4 w-4 accent-brand-600"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
          data-testid="warehouse-default"
        />
        <span>{t('organisation.makeDefault')}</span>
      </label>
    </ConfirmDialog>
  );
}
