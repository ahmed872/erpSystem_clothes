import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { describeError } from '../lib/apiClient';
import {
  canDeleteRole,
  canRenameRole,
  groupPermissions,
  isSystemRole,
  permissionCodesOf,
  roleAssignmentCount,
  wouldLockSelfOut,
} from '../lib/admin';
import { usePermission } from '../hooks/usePermission';
import { useAuthStore } from '../store/authStore';
import type { AdminRole, PermissionCatalogEntry } from '../lib/apiTypes';

/**
 * Phase 20 — ROLES AND PERMISSIONS.
 *
 * THE PERMISSION CATALOG IS FETCHED, NEVER HARDCODED. `GET /permissions`
 * returns 117 global, immutable codes; a copy written down in this app
 * would drift from the one the server actually authorizes against, and
 * the drift would show up as a role that silently grants nothing.
 *
 * TWO SERVER RULES THIS SCREEN STATES RATHER THAN DISCOVERS:
 *
 *   1. A BUILT-IN TEMPLATE CANNOT BE RENAMED, though its permission set
 *      remains editable — a tenant may reasonably decide their Cashier
 *      should not read stock. So the name field is disabled on a system
 *      role and the permission picker is not.
 *
 *   2. NO EDIT MAY COST THE CALLER THEIR OWN `roles.view`/`roles.edit`.
 *      This is enforced SERVER-SIDE (Phase 20 owner decision B, after
 *      discovery reproduced a tenant permanently locking itself out of
 *      its own administration with one request). The warning below is a
 *      COURTESY — it computes the same thing the server does, from the
 *      caller's own roles, so a well-meant edit is caught before it is
 *      submitted. It is not the boundary: the server refuses the request
 *      whatever this screen shows, and a browser with this check patched
 *      out gets a 409.
 *
 * NO ROLE NAME IS USED FOR AUTHORIZATION. `isSystem` is a flag on the
 * row, not a comparison against "BUSINESS_OWNER".
 */
export function AdminRolesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canCreate = usePermission('roles.create');
  const canEdit = usePermission('roles.edit');
  const canDelete = usePermission('roles.delete');
  const canViewPermissions = usePermission('permissions.view');
  const canViewUsers = usePermission('users.view');
  const myId = useAuthStore((s) => s.user?.id);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminRole | null>(null);
  const [deleting, setDeleting] = useState<AdminRole | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: () => adminApi.listRoles() });
  const catalog = useQuery({
    queryKey: ['permission-catalog'],
    queryFn: () => adminApi.listPermissions(),
    enabled: canViewPermissions,
    // The catalog is global and immutable; it cannot change under us.
    staleTime: Infinity,
  });
  // Only to show how many people hold a role and whether it is deletable.
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => adminApi.listUsers(), enabled: canViewUsers });

  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }
  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
    // A role change alters the caller's OWN effective permissions
    // immediately, server-side — so the shell re-reads them rather than
    // trusting the copy it holds.
    await queryClient.invalidateQueries({ queryKey: ['my-permissions'] });
  }

  const remove = useMutation({
    mutationFn: () => adminApi.deleteRole(deleting!.id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh(t('admin.roles.deleted'));
    },
    onError: (e) => {
      setDeleting(null);
      fail(e);
    },
  });

  const rows = useMemo(() => roles.data?.data ?? [], [roles.data]);
  const userRows = useMemo(() => users.data?.data ?? [], [users.data]);

  // The caller's OWN roles, so the dialog can warn about a self-lockout
  // exactly as the server computes it. Resolved from the user list we
  // already hold; when the caller cannot read users, this is empty, no
  // warning is shown, and the SERVER remains the only check — which is
  // the correct direction to fail in.
  const myRoles = useMemo(() => {
    const mine = userRows.find((u) => u.id === myId);
    if (!mine) return [];
    const held = new Set(mine.userRoles.map((ur) => ur.role.id));
    return rows.filter((r) => held.has(r.id));
  }, [userRows, rows, myId]);

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('admin.roles.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('admin.roles.explainer')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)} data-testid="new-role">
            {t('admin.roles.newRole')}
          </Button>
        )}
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="admin-roles-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}
      {roles.isError && <ErrorBanner {...describeError(roles.error)} />}

      <DataTable
        data-testid="roles-table"
        loading={roles.isLoading}
        rows={rows}
        rowKey={(r) => r.id}
        empty={t('admin.roles.none')}
        columns={[
          {
            key: 'name',
            header: t('admin.roles.name'),
            cell: (r: AdminRole) => (
              <span className="flex flex-wrap items-center gap-1">
                {r.name}
                {isSystemRole(r) && <Badge tone="neutral">{t('admin.roles.builtIn')}</Badge>}
              </span>
            ),
          },
          {
            key: 'permissions',
            header: t('admin.roles.permissionCount'),
            align: 'end',
            className: 'numeric',
            cell: (r) => String(r.rolePermissions.length),
          },
          ...(canViewUsers
            ? [
                {
                  key: 'assigned',
                  header: t('admin.roles.assignedTo'),
                  align: 'end' as const,
                  className: 'numeric',
                  cell: (r: AdminRole) => String(roleAssignmentCount(r, userRows)),
                },
              ]
            : []),
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (r) => (
              <div className="flex flex-wrap justify-end gap-1">
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)} data-testid={`edit-role-${r.id}`}>
                    {t('common.edit')}
                  </Button>
                )}
                {/* Offered only where the server would accept it: never
                    for a built-in template, never while assigned. */}
                {canDelete && canViewUsers && canDeleteRole(r, userRows) && (
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(r)} data-testid={`delete-role-${r.id}`}>
                    {t('common.delete')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      <Card className="mt-3">
        <CardBody className="p-3">
          <p className="text-xs leading-snug text-neutral-500" data-testid="roles-hint">
            {t('admin.roles.hint')}
          </p>
        </CardBody>
      </Card>

      {(creating || editing) && (
        <RoleDialog
          role={editing}
          catalog={catalog.data?.data ?? []}
          myRoles={myRoles}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onError={fail}
          onSaved={async () => {
            const wasEditing = Boolean(editing);
            setCreating(false);
            setEditing(null);
            await refresh(t(wasEditing ? 'admin.roles.updated' : 'admin.roles.created'));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        tone="danger"
        title={t('admin.roles.deleteTitle')}
        message={t('admin.roles.deleteWarning')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onClose={() => setDeleting(null)}
        data-testid="delete-role-dialog"
      />
    </div>
  );
}

// ====================================================================
function RoleDialog({
  role,
  catalog,
  myRoles,
  onClose,
  onSaved,
  onError,
}: {
  role: AdminRole | null;
  catalog: PermissionCatalogEntry[];
  /** The caller's own roles, for the self-lockout warning. Empty means
   *  no warning and the server as the only check. */
  myRoles: AdminRole[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(role?.name ?? '');
  const [codes, setCodes] = useState<string[]>(role ? permissionCodesOf(role) : []);

  const groups = useMemo(() => groupPermissions(catalog), [catalog]);
  const locksMeOut = role ? wouldLockSelfOut(role.id, codes, myRoles) : false;
  const renameBlocked = role ? !canRenameRole(role) : false;

  const save = useMutation({
    mutationFn: () =>
      role
        ? adminApi.updateRole(role.id, {
            // A built-in template's name is fixed server-side, so it is
            // not even sent — the field is disabled above.
            ...(renameBlocked ? {} : { name: name.trim() }),
            permissionCodes: codes,
          })
        : adminApi.createRole({ name: name.trim(), permissionCodes: codes }),
    onSuccess: onSaved,
    onError,
  });

  const toggle = (code: string) => setCodes(codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code]);
  const toggleGroup = (entries: PermissionCatalogEntry[]) => {
    const all = entries.every((e) => codes.includes(e.code));
    const groupCodes = entries.map((e) => e.code);
    setCodes(all ? codes.filter((c) => !groupCodes.includes(c)) : [...new Set([...codes, ...groupCodes])]);
  };

  return (
    <ConfirmDialog
      open
      title={t(role ? 'admin.roles.editRole' : 'admin.roles.newRole')}
      confirmLabel={t(role ? 'common.save' : 'common.create')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      // Blocked locally too, so a click cannot even attempt what the
      // server will refuse. The server is still the boundary.
      onConfirm={() => (locksMeOut ? undefined : save.mutate())}
      onClose={onClose}
      data-testid="role-dialog"
    >
      {renameBlocked ? (
        <p className="text-xs text-neutral-500" data-testid="role-name-locked">
          {t('admin.roles.nameFixed', { name: role!.name })}
        </p>
      ) : (
        <Input label={t('admin.roles.name')} value={name} onChange={(e) => setName(e.target.value)} data-testid="role-name" />
      )}

      {locksMeOut && (
        <div className="rounded-lg border border-danger-200 bg-danger-50 p-3" data-testid="lockout-warning">
          <p className="text-xs font-semibold leading-snug text-danger-700">{t('admin.roles.lockoutWarning')}</p>
        </div>
      )}

      <p className="mt-1 text-xs font-semibold text-neutral-700">
        {t('admin.roles.permissionsSelected', { count: codes.length, total: catalog.length })}
      </p>
      {catalog.length === 0 && <p className="text-xs text-neutral-500">{t('admin.roles.noCatalog')}</p>}

      <div className="max-h-72 overflow-y-auto" data-testid="permission-picker">
        {groups.map(([group, entries]) => (
          <div key={group} className="mb-2">
            <button
              type="button"
              onClick={() => toggleGroup(entries)}
              className="mb-1 text-xs font-bold text-brand-700"
              data-testid={`permission-group-${group}`}
            >
              {group}
            </button>
            <div className="flex flex-wrap gap-1">
              {entries.map((entry) => (
                <button
                  key={entry.code}
                  type="button"
                  onClick={() => toggle(entry.code)}
                  title={entry.description ?? entry.code}
                  className={`numeric rounded-lg border px-2 py-0.5 text-[11px] ${
                    codes.includes(entry.code)
                      ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700'
                      : 'border-neutral-200 text-neutral-600'
                  }`}
                  data-testid={`permission-${entry.code}`}
                >
                  {entry.code}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </ConfirmDialog>
  );
}
