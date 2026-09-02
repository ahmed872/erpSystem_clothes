import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, ConfirmDialog, DataTable, ErrorBanner, Input, Modal } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { describeError } from '../lib/apiClient';
import {
  callerRoleIds,
  canDeleteRole,
  canRenameRole,
  groupPermissions,
  permissionCodesOf,
  roleEditBlock,
  rolePermissionCatalog,
  selectedInGroup,
  toggleGroup,
  type PermissionGroup,
  type RoleEditBlock,
} from '../lib/admin';
import { usePermission } from '../hooks/usePermission';
import { useAuthStore } from '../store/authStore';
import type { PermissionCatalogEntry, PermissionCode, Role } from '../lib/apiTypes';

/**
 * Phase 20 — WHAT A ROLE MAY DO.
 *
 * THE SERVER IS THE AUTHORITY, ALWAYS. Every rule this screen explains is
 * enforced in `UpdateRoleUseCase` and re-checked on every request. The
 * point of explaining it here is that a refusal arriving as a 409 AFTER
 * the administrator has spent five minutes rebuilding a permission set is
 * a bad experience, not that the browser decides anything.
 *
 * DECISION B, AS A SCREEN:
 *
 *   - Custom roles are fully editable (rule 1).
 *   - System roles are permission-editable (rule 2) but their NAME field
 *     is read-only (rule 4) — the input is disabled and says why.
 *   - `roles.view` and `roles.edit` cannot be cleared from a role the
 *     caller holds (rule 3). Those two checkboxes are locked on that one
 *     role, and the save is blocked with an explanation rather than sent
 *     to be refused.
 *
 * WHOSE ROLES ARE "THE CALLER'S"? Read from the real user list for the
 * real signed-in user id — `callerRoleIds` in `lib/admin.ts`. Never a role
 * NAME, never a constant, and never anything the caller could influence.
 * When that list is unavailable (a caller holding `roles.view` need not
 * hold `users.view`) the answer is `null` and this screen predicts
 * NOTHING: it sends the change and shows whatever the server says. An
 * unknown is not permission to guess.
 *
 * THERE IS NO PERMISSION-MANAGEMENT SCREEN. Permissions are the product's
 * fixed vocabulary — `GET /permissions` is a read-only catalogue with no
 * create, edit or delete anywhere in the contract. They are assigned here
 * and nowhere else.
 */
export function RolesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canCreate = usePermission('roles.create');
  const canEdit = usePermission('roles.edit');
  const canDelete = usePermission('roles.delete');
  const canSeeCatalog = usePermission('permissions.view');
  const canSeeUsers = usePermission('users.view');
  const myUserId = useAuthStore((s) => s.user?.id);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => adminApi.listRoles() });
  // The vocabulary a role is built from. Gated on `permissions.view`: a
  // caller without it can still READ roles and their grants (which arrive
  // on the role itself) but cannot be offered a catalogue they may not
  // fetch.
  const catalog = useQuery({
    queryKey: ['admin', 'permission-catalog'],
    queryFn: () => adminApi.listPermissionCatalog(),
    enabled: canSeeCatalog,
  });
  // Only to answer "which roles do I hold". Not fetched at all without
  // `users.view`, in which case the lockout hint is simply absent and the
  // server does the refusing.
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => adminApi.listUsers(),
    enabled: canSeeUsers,
  });

  const myRoleIds = callerRoleIds(users.data?.data, myUserId);
  const rows = roles.data?.data ?? [];

  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }
  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
  }

  const remove = useMutation({
    mutationFn: () => adminApi.deleteRole(deleting!.id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh(t('roles.deleted'));
    },
    onError: (e) => {
      setDeleting(null);
      fail(e);
    },
  });

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('roles.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('roles.explainer')}</p>
        </div>
        {canCreate && canSeeCatalog && (
          <Button onClick={() => setCreating(true)} data-testid="new-role">
            {t('roles.newRole')}
          </Button>
        )}
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="role-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}
      {roles.isError && <ErrorBanner {...describeError(roles.error)} />}
      {canEdit && !canSeeCatalog && (
        <div className="mb-3 rounded-lg border border-warning-200 bg-warning-50 p-3" data-testid="no-catalog-notice">
          <p className="text-sm text-warning-800">{t('roles.needsCatalog')}</p>
        </div>
      )}

      <DataTable
        data-testid="roles-table"
        loading={roles.isLoading}
        rows={rows}
        rowKey={(r) => r.id}
        empty={t('roles.none')}
        columns={[
          {
            key: 'name',
            header: t('roles.name'),
            cell: (r: Role) => (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-neutral-900">{r.name}</span>
                {r.isSystem && <Badge tone="neutral">{t('roles.systemRole')}</Badge>}
                {myRoleIds?.includes(r.id) && (
                  <Badge tone="brand" data-testid={`your-role-${r.id}`}>
                    {t('roles.yourRole')}
                  </Badge>
                )}
              </div>
            ),
          },
          {
            key: 'permissions',
            header: t('roles.permissionCount'),
            align: 'end',
            className: 'numeric',
            cell: (r) => String(r.rolePermissions.length),
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (r) => (
              <div className="flex flex-wrap justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)} data-testid={`open-role-${r.id}`}>
                  {t(canEdit && canSeeCatalog ? 'common.edit' : 'roles.viewPermissions')}
                </Button>
                {canDelete && canDeleteRole(r) && (
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(r)} data-testid={`delete-role-${r.id}`}>
                    {t('common.remove')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      {(creating || editing) && (
        <RoleDialog
          role={editing}
          catalog={catalog.data?.data ?? []}
          catalogLoading={catalog.isLoading}
          editable={canSeeCatalog && (editing ? canEdit : canCreate)}
          callerRoleIds={myRoleIds}
          callerRolesKnown={canSeeUsers && users.isSuccess}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onError={fail}
          onSaved={async () => {
            const wasEditing = Boolean(editing);
            setCreating(false);
            setEditing(null);
            await refresh(t(wasEditing ? 'roles.updated' : 'roles.created'));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        tone="danger"
        title={t('roles.deleteTitle')}
        message={t('roles.deleteWarning', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.remove')}
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
/**
 * The role editor. Also the role VIEWER: a caller who may read roles but
 * not edit them opens the same dialog with every control disabled, which
 * is more useful than a permission count on a table row.
 */
function RoleDialog({
  role,
  catalog,
  catalogLoading,
  editable,
  callerRoleIds: heldRoleIds,
  callerRolesKnown,
  onClose,
  onSaved,
  onError,
}: {
  role: Role | null;
  catalog: PermissionCatalogEntry[];
  catalogLoading: boolean;
  editable: boolean;
  callerRoleIds: string[] | null;
  callerRolesKnown: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(role?.name ?? '');
  const [selected, setSelected] = useState<Set<PermissionCode>>(
    () => new Set(role ? permissionCodesOf(role) : []),
  );

  /**
   * The catalogue when the caller may read it; otherwise the role's OWN
   * grants, which arrive on the role itself with their codes and
   * descriptions.
   *
   * A caller holding `roles.view` need not hold `permissions.view`, and
   * showing them an empty list would say "this role grants nothing" —
   * which is false, and is data they already have in hand. What they
   * cannot see is what the role does NOT grant, which is exactly the
   * difference the missing permission describes.
   */
  const groups = useMemo(
    () => groupPermissions(catalog.length > 0 || !role ? catalog : rolePermissionCatalog(role)),
    [catalog, role],
  );
  const nextCodes = useMemo(() => [...selected], [selected]);

  // Decision B, predicted only where the browser can honestly predict it.
  const block: RoleEditBlock = role
    ? roleEditBlock({ role, nextName: name, nextCodes, callerRoleIds: heldRoleIds })
    : null;

  const nameLocked = Boolean(role && !canRenameRole(role));
  /** The caller's own role: those two checkboxes stay ticked and disabled
   *  rather than letting someone build a set the server will refuse. */
  const lockedCodes = useMemo<Set<PermissionCode>>(() => {
    if (!role || !heldRoleIds?.includes(role.id)) return new Set();
    const current = new Set(permissionCodesOf(role));
    return new Set(['roles.view', 'roles.edit'].filter((c) => current.has(c)));
  }, [role, heldRoleIds]);

  const save = useMutation({
    mutationFn: () =>
      role
        ? adminApi.updateRole(role.id, {
            // A system role's name is never sent: the field is read-only
            // and re-sending the same value would be noise in the audit
            // trail even though the server accepts it.
            ...(nameLocked ? {} : { name: name.trim() }),
            permissionCodes: nextCodes,
          })
        : adminApi.createRole({ name: name.trim(), permissionCodes: nextCodes }),
    onSuccess: onSaved,
    onError,
  });

  function toggleCode(code: PermissionCode) {
    if (lockedCodes.has(code)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleWholeGroup(group: PermissionGroup) {
    setSelected((prev) => {
      const next = toggleGroup(group, prev);
      // A locked code survives a select-all-off: the whole point is that
      // it cannot be cleared from this role by this caller.
      for (const code of lockedCodes) next.add(code);
      return next;
    });
  }

  const canSubmit = editable && block === null && nextCodes.length > 0 && name.trim().length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={role ? t('roles.editRole', { name: role.name }) : t('roles.newRole')}
    >
      <div className="flex flex-col gap-3" data-testid="role-dialog">
        <Input
          label={t('roles.name')}
          value={name}
          disabled={!editable || nameLocked}
          onChange={(e) => setName(e.target.value)}
          hint={nameLocked ? t('roles.systemNameLocked') : undefined}
          data-testid="role-name"
        />

        {block?.reason === 'roleAdminLockout' && (
          <div className="rounded-lg border border-danger-200 bg-danger-50 p-3" data-testid="role-lockout-warning">
            <p className="text-sm font-semibold text-danger-700">{t('roles.lockoutTitle')}</p>
            <p className="text-xs leading-snug text-danger-700">
              {t('roles.lockoutWarning', { codes: block.codes.join('، ') })}
            </p>
          </div>
        )}
        {block?.reason === 'systemRename' && (
          <div className="rounded-lg border border-danger-200 bg-danger-50 p-3" data-testid="role-rename-warning">
            <p className="text-xs leading-snug text-danger-700">{t('roles.systemNameLocked')}</p>
          </div>
        )}
        {role && heldRoleIds?.includes(role.id) && lockedCodes.size > 0 && (
          <p className="text-xs leading-snug text-neutral-500" data-testid="role-self-notice">
            {t('roles.selfEditNotice')}
          </p>
        )}
        {editable && !callerRolesKnown && (
          // Honest about what it does not know, rather than silently
          // rendering as though the check had been made.
          <p className="text-xs leading-snug text-neutral-500" data-testid="role-unknown-notice">
            {t('roles.callerRolesUnknown')}
          </p>
        )}

        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-neutral-700">{t('roles.permissions')}</p>
          <p className="text-xs text-neutral-500" data-testid="role-selected-count">
            {t('roles.selectedCount', { count: nextCodes.length })}
          </p>
        </div>

        {catalogLoading && <p className="text-sm text-neutral-500">{t('common.loading')}</p>}
        {!catalogLoading && groups.length === 0 && <p className="text-sm text-neutral-500">{t('common.noResults')}</p>}

        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-neutral-200">
          {groups.map((group) => (
            <PermissionGroupSection
              key={group.domain}
              group={group}
              selected={selected}
              lockedCodes={lockedCodes}
              editable={editable}
              onToggleCode={toggleCode}
              onToggleGroup={() => toggleWholeGroup(group)}
            />
          ))}
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" fullWidth onClick={onClose} disabled={save.isPending}>
            {t(editable ? 'common.cancel' : 'common.close')}
          </Button>
          {editable && (
            <Button
              fullWidth
              loading={save.isPending}
              disabled={!canSubmit || save.isPending}
              onClick={() => save.mutate()}
              data-testid="save-role"
            >
              {t(role ? 'common.save' : 'common.create')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ====================================================================
function PermissionGroupSection({
  group,
  selected,
  lockedCodes,
  editable,
  onToggleCode,
  onToggleGroup,
}: {
  group: PermissionGroup;
  selected: Set<PermissionCode>;
  lockedCodes: Set<PermissionCode>;
  editable: boolean;
  onToggleCode: (code: PermissionCode) => void;
  onToggleGroup: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const count = selectedInGroup(group, selected);

  return (
    <div className="border-b border-neutral-200 last:border-b-0" data-testid={`permission-group-${group.domain}`}>
      <div className="flex items-center justify-between gap-2 bg-neutral-50 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-start text-sm font-semibold text-neutral-800"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid={`permission-group-toggle-${group.domain}`}
        >
          {/* A caret that flips vertically, never horizontally: it must not
              need mirroring under RTL. */}
          <span aria-hidden className="text-neutral-400">
            {open ? '▾' : '▸'}
          </span>
          <span className="truncate">{t(`permissionDomains.${group.domain}`, { defaultValue: group.domain })}</span>
          <span className="shrink-0 text-xs font-normal text-neutral-500">
            {count}/{group.permissions.length}
          </span>
        </button>
        {editable && (
          <Button size="sm" variant="ghost" onClick={onToggleGroup} data-testid={`permission-group-all-${group.domain}`}>
            {t(count === group.permissions.length ? 'roles.clearAll' : 'roles.selectAll')}
          </Button>
        )}
      </div>
      {open && (
        <div className="px-3 py-2">
          {group.permissions.map((permission) => {
            const locked = lockedCodes.has(permission.code);
            return (
              <label
                key={permission.code}
                className="flex items-start gap-2 py-1 text-sm text-neutral-800"
                title={locked ? t('roles.codeLocked') : undefined}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
                  checked={selected.has(permission.code)}
                  disabled={!editable || locked}
                  onChange={() => onToggleCode(permission.code)}
                  data-testid={`permission-${permission.code}`}
                />
                <span className="min-w-0">
                  <span className="block break-words font-mono text-xs text-neutral-900">{permission.code}</span>
                  <span className="block text-xs leading-snug text-neutral-500">{permission.description}</span>
                </span>
                {locked && (
                  <Badge tone="warning" className="shrink-0">
                    {t('roles.locked')}
                  </Badge>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
