import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { describeError } from '../lib/apiClient';
import { formatDateTime } from '../lib/datetime';
import { isSuspended, userTone } from '../lib/admin';
import { usePermission } from '../hooks/usePermission';
import { useAuthStore } from '../store/authStore';
import type { AdminBranch, AdminRole, AdminUser } from '../lib/apiTypes';

/**
 * Phase 20 — USERS.
 *
 * THE LIST IS THE DETAIL. `GET /users` takes no search, filter or
 * pagination parameter and there is no `GET /users/:id`, so this screen
 * shows the whole tenant and has no detail route. At shop scale that is
 * the right shape; if a tenant ever outgrows it the fix is a server-side
 * filter, not a client-side one over a page that is already complete.
 *
 * ROLES AND BRANCHES ARE REPLACEMENT ARRAYS. The dialogs always submit
 * the whole intended list, because a partial one removes what it omits.
 *
 * SUSPENSION, NOT DELETION. `DELETE /users/:id` sets `status:
 * SUSPENDED`; nothing is ever removed, because every sale, shift and
 * audit row ever written still names the user. The server refuses to
 * suspend or de-role the last active Business Owner, and that refusal is
 * shown verbatim rather than predicted here.
 *
 * PASSWORDS ARE WRITE-ONLY IN BOTH DIRECTIONS. No user response carries a
 * hash or a token, and this screen never renders one.
 */
export function AdminUsersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canCreate = usePermission('users.create');
  const canEdit = usePermission('users.edit');
  const canSuspend = usePermission('users.delete');
  const canViewRoles = usePermission('roles.view');
  const canViewBranches = usePermission('branches.view');
  const myId = useAuthStore((s) => s.user?.id);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [suspending, setSuspending] = useState<AdminUser | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => adminApi.listUsers() });
  // Roles and branches are needed to ASSIGN them; a caller who cannot
  // read them gets a screen without those controls rather than a 403.
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: () => adminApi.listRoles(), enabled: canViewRoles });
  const branches = useQuery({ queryKey: ['admin-branches'], queryFn: () => adminApi.listBranches(), enabled: canViewBranches });

  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }
  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['admin-users'] });
  }

  const suspend = useMutation({
    mutationFn: () => adminApi.suspendUser(suspending!.id),
    onSuccess: async () => {
      setSuspending(null);
      await refresh(t('admin.users.suspended'));
    },
    onError: (e) => {
      setSuspending(null);
      fail(e);
    },
  });

  const rows = users.data?.data ?? [];

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('admin.users.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('admin.users.explainer')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)} data-testid="new-user">
            {t('admin.users.newUser')}
          </Button>
        )}
      </div>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="admin-users-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}
      {users.isError && <ErrorBanner {...describeError(users.error)} />}

      <DataTable
        data-testid="users-table"
        loading={users.isLoading}
        rows={rows}
        rowKey={(u) => u.id}
        empty={t('admin.users.none')}
        columns={[
          {
            key: 'name',
            header: t('admin.users.name'),
            cell: (u: AdminUser) => (
              <span className="flex flex-wrap items-center gap-1">
                {u.name}
                {u.id === myId && <Badge tone="brand">{t('admin.users.you')}</Badge>}
              </span>
            ),
          },
          { key: 'email', header: t('admin.users.email'), cell: (u) => u.email },
          {
            key: 'roles',
            header: t('admin.users.roles'),
            cell: (u) => (u.userRoles.length ? u.userRoles.map((ur) => ur.role.name).join(', ') : '—'),
          },
          {
            key: 'branches',
            header: t('admin.users.branches'),
            cell: (u) => (u.userBranches.length ? u.userBranches.map((ub) => ub.branch.name).join(', ') : t('admin.users.allBranches')),
          },
          {
            key: 'lastLogin',
            header: t('admin.users.lastLogin'),
            cell: (u) => (u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('admin.users.never')),
          },
          {
            key: 'status',
            header: t('admin.users.status'),
            cell: (u) => <Badge tone={userTone(u)}>{t(`admin.users.statusLabel.${u.status}`)}</Badge>,
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (u) => (
              <div className="flex flex-wrap justify-end gap-1">
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(u)} data-testid={`edit-user-${u.id}`}>
                    {t('common.edit')}
                  </Button>
                )}
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setResetting(u)} data-testid={`reset-password-${u.id}`}>
                    {t('admin.users.resetPassword')}
                  </Button>
                )}
                {/* Suspension is offered only on an ACTIVE user; the
                    server 409s on the last owner regardless. */}
                {canSuspend && !isSuspended(u) && (
                  <Button size="sm" variant="ghost" onClick={() => setSuspending(u)} data-testid={`suspend-user-${u.id}`}>
                    {t('admin.users.suspend')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      <Card className="mt-3">
        <CardBody className="p-3">
          <p className="text-xs leading-snug text-neutral-500">{t('admin.users.listHint')}</p>
        </CardBody>
      </Card>

      {(creating || editing) && (
        <UserDialog
          user={editing}
          roles={roles.data?.data ?? []}
          branches={branches.data?.data ?? []}
          canAssignRoles={canViewRoles}
          canAssignBranches={canViewBranches}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onError={fail}
          onSaved={async () => {
            const wasEditing = Boolean(editing);
            setCreating(false);
            setEditing(null);
            await refresh(t(wasEditing ? 'admin.users.updated' : 'admin.users.created'));
          }}
        />
      )}

      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onError={fail}
          onSaved={async () => {
            setResetting(null);
            await refresh(t('admin.users.passwordReset'));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(suspending)}
        tone="danger"
        title={t('admin.users.suspendTitle')}
        message={t('admin.users.suspendWarning')}
        confirmLabel={t('admin.users.suspend')}
        cancelLabel={t('common.cancel')}
        pending={suspend.isPending}
        onConfirm={() => suspend.mutate()}
        onClose={() => setSuspending(null)}
        data-testid="suspend-user-dialog"
      />
    </div>
  );
}

// ====================================================================
/**
 * Create and edit. The two differ in more than a title: creation demands
 * an email and a password the contract will not let us change later
 * through this form, while editing can move a user between ACTIVE and
 * SUSPENDED and cannot touch their email at all — `updateUserSchema`
 * accepts no email field.
 */
function UserDialog({
  user,
  roles,
  branches,
  canAssignRoles,
  canAssignBranches,
  onClose,
  onSaved,
  onError,
}: {
  user: AdminUser | null;
  roles: AdminRole[];
  branches: AdminBranch[];
  canAssignRoles: boolean;
  canAssignBranches: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState(user?.status ?? 'ACTIVE');
  const [roleIds, setRoleIds] = useState<string[]>(user?.userRoles.map((ur) => ur.role.id) ?? []);
  const [branchIds, setBranchIds] = useState<string[]>(user?.userBranches.map((ub) => ub.branch.id) ?? []);

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const save = useMutation({
    mutationFn: () =>
      user
        ? // Always the WHOLE list: these are replacement arrays.
          adminApi.updateUser(user.id, {
            name: name.trim(),
            status,
            ...(canAssignRoles ? { roleIds } : {}),
            ...(canAssignBranches ? { branchIds } : {}),
          })
        : adminApi.createUser({ name: name.trim(), email: email.trim(), password, roleIds, branchIds }),
    onSuccess: onSaved,
    onError,
  });

  return (
    <ConfirmDialog
      open
      title={t(user ? 'admin.users.editUser' : 'admin.users.newUser')}
      confirmLabel={t(user ? 'common.save' : 'common.create')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="user-dialog"
    >
      <Input label={t('admin.users.name')} value={name} onChange={(e) => setName(e.target.value)} data-testid="user-name" />
      {user ? (
        <p className="text-xs text-neutral-500" data-testid="user-email-readonly">
          {t('admin.users.emailFixed', { email: user.email })}
        </p>
      ) : (
        <>
          <Input label={t('admin.users.email')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="user-email" />
          <Input
            label={t('admin.users.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="user-password"
          />
          <p className="text-xs text-neutral-500">{t('admin.users.passwordRule')}</p>
        </>
      )}

      {user && (
        <div className="mt-1">
          <p className="mb-1 text-xs font-semibold text-neutral-700">{t('admin.users.status')}</p>
          <div className="flex gap-2">
            {(['ACTIVE', 'SUSPENDED'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={`rounded-lg border px-2.5 py-1 text-xs ${
                  status === s ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700' : 'border-neutral-200 text-neutral-600'
                }`}
                data-testid={`user-status-${s}`}
              >
                {t(`admin.users.statusLabel.${s}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {canAssignRoles && (
        <CheckList
          label={t('admin.users.roles')}
          hint={t('admin.users.rolesHint')}
          items={roles.map((r) => ({ id: r.id, label: r.name }))}
          selected={roleIds}
          onToggle={(id) => setRoleIds(toggle(roleIds, id))}
          testId="user-roles"
        />
      )}
      {canAssignBranches && (
        <CheckList
          label={t('admin.users.branches')}
          hint={t('admin.users.branchesHint')}
          items={branches.map((b) => ({ id: b.id, label: b.name }))}
          selected={branchIds}
          onToggle={(id) => setBranchIds(toggle(branchIds, id))}
          testId="user-branches"
        />
      )}
    </ConfirmDialog>
  );
}

// ====================================================================
function ResetPasswordDialog({
  user,
  onClose,
  onSaved,
  onError,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const save = useMutation({
    mutationFn: () => adminApi.resetPassword(user.id, password),
    onSuccess: onSaved,
    onError,
  });

  return (
    <ConfirmDialog
      open
      tone="danger"
      title={t('admin.users.resetPasswordTitle', { name: user.name })}
      message={t('admin.users.resetPasswordWarning')}
      confirmLabel={t('admin.users.resetPassword')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="reset-password-dialog"
    >
      <Input
        label={t('admin.users.newPassword')}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        data-testid="new-password"
      />
      <p className="text-xs text-neutral-500">{t('admin.users.passwordRule')}</p>
    </ConfirmDialog>
  );
}

// ====================================================================
export function CheckList({
  label,
  hint,
  items,
  selected,
  onToggle,
  testId,
}: {
  label: string;
  hint?: string;
  items: { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string) => void;
  testId: string;
}) {
  return (
    <div className="mt-1" data-testid={testId}>
      <p className="mb-1 text-xs font-semibold text-neutral-700">{label}</p>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onToggle(item.id)}
            className={`rounded-lg border px-2.5 py-1 text-xs ${
              selected.includes(item.id)
                ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700'
                : 'border-neutral-200 text-neutral-600'
            }`}
            data-testid={`${testId}-${item.id}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {hint && <p className="mt-1 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}
