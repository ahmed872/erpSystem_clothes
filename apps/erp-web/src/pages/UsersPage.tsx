import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Select } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { describeError } from '../lib/apiClient';
import { formatDateTime } from '../lib/datetime';
import {
  branchNamesOf,
  isScopedToAllBranches,
  matchesUserSearch,
  roleNamesOf,
  sortUsers,
  userStatusTone,
} from '../lib/admin';
import { usePermission } from '../hooks/usePermission';
import type { AdminUser, Branch, Role } from '../lib/apiTypes';

/**
 * Phase 20 — WHO CAN SIGN IN, AND AS WHAT.
 *
 * THE CONTRACT IS UNPAGED AND UNFILTERED. `GET /users` takes no `search`,
 * `status`, `page` or `limit` — unlike suppliers or customers, which do.
 * So this screen narrows the list it already received, in the browser, and
 * the counter says "showing N of M" rather than implying the server
 * searched. Inventing `?search=` would 404 or be silently ignored.
 *
 * SUSPENSION, NOT DELETION. `DELETE /users/:id` sets `status: SUSPENDED`
 * server-side; the row survives, because an audit trail that points at a
 * deleted user is a trail with a hole in it. The button says what happens.
 *
 * THE LAST-OWNER GUARD IS THE SERVER'S. Suspending or de-owning the final
 * active Business Owner is refused with a 409 that this screen shows
 * verbatim. It is deliberately NOT predicted here: the browser would have
 * to count owners across a list it may only partly hold, and a wrong
 * prediction either blocks a legal act or promises an illegal one.
 *
 * A PASSWORD RESET SIGNS THAT PERSON OUT EVERYWHERE, including on the
 * device they are holding. The server returns how many sessions it ended
 * and the dialog says so before asking, because a cashier discovering it
 * mid-shift is a support call.
 */
export function UsersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canCreate = usePermission('users.create');
  const canEdit = usePermission('users.edit');
  const canSuspend = usePermission('users.delete');
  const canSeeRoles = usePermission('roles.view');
  const canSeeBranches = usePermission('branches.view');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'ACTIVE' | 'SUSPENDED'>('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [suspending, setSuspending] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => adminApi.listUsers() });
  // Roles and branches are what an assignment is MADE of, so they are
  // fetched only for callers who may read them. Without `roles.view` the
  // role picker is absent rather than empty — the backend would refuse the
  // call anyway, and an empty picker reads as "there are no roles".
  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => adminApi.listRoles(),
    enabled: canSeeRoles,
  });
  const branches = useQuery({
    queryKey: ['admin', 'branches'],
    queryFn: () => adminApi.listBranches(),
    enabled: canSeeBranches,
  });

  const loaded = users.data?.data;
  const all = useMemo(() => loaded ?? [], [loaded]);
  const rows = useMemo(
    () =>
      sortUsers(all).filter(
        (u) => matchesUserSearch(u, search) && (statusFilter === '' || u.status === statusFilter),
      ),
    [all, search, statusFilter],
  );

  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }
  async function refresh(message: string) {
    setError(null);
    setOk(message);
    await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  }

  const suspend = useMutation({
    mutationFn: () => adminApi.suspendUser(suspending!.id),
    onSuccess: async () => {
      setSuspending(null);
      await refresh(t('users.suspended'));
    },
    onError: (e) => {
      setSuspending(null);
      fail(e);
    },
  });

  const reactivate = useMutation({
    mutationFn: (user: AdminUser) => adminApi.updateUser(user.id, { status: 'ACTIVE' }),
    onSuccess: () => refresh(t('users.reactivated')),
    onError: fail,
  });

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-neutral-900">{t('users.title')}</h1>
          <p className="text-xs leading-snug text-neutral-500">{t('users.explainer')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)} data-testid="new-user">
            {t('users.newUser')}
          </Button>
        )}
      </div>

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 p-3">
          <Input
            label={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('users.searchHint')}
            data-testid="user-search"
          />
          <Select
            label={t('users.status')}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | 'ACTIVE' | 'SUSPENDED')}
            data-testid="user-status-filter"
          >
            <option value="">{t('users.allStatuses')}</option>
            <option value="ACTIVE">{t('users.active')}</option>
            <option value="SUSPENDED">{t('users.suspended_label')}</option>
          </Select>
          {/* Said plainly, because the narrowing is this screen's and not
              the server's — see the header comment. */}
          <p className="pb-2 text-xs text-neutral-500" data-testid="user-count">
            {t('users.showingCount', { shown: rows.length, total: all.length })}
          </p>
        </CardBody>
      </Card>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="user-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}
      {users.isError && <ErrorBanner {...describeError(users.error)} />}

      <DataTable
        data-testid="users-table"
        loading={users.isLoading}
        rows={rows}
        rowKey={(u) => u.id}
        empty={t('users.none')}
        columns={[
          {
            key: 'name',
            header: t('users.name'),
            cell: (u: AdminUser) => (
              <div>
                <p className="font-semibold text-neutral-900">{u.name}</p>
                <p className="text-xs text-neutral-500">{u.email}</p>
              </div>
            ),
          },
          {
            key: 'roles',
            header: t('users.roles'),
            cell: (u) => (
              <div className="flex flex-wrap gap-1">
                {roleNamesOf(u).map((name) => (
                  <Badge key={name} tone="brand">
                    {name}
                  </Badge>
                ))}
                {u.userRoles.length === 0 && <span className="text-neutral-400">—</span>}
              </div>
            ),
          },
          {
            key: 'branches',
            header: t('users.branches'),
            cell: (u) =>
              isScopedToAllBranches(u) ? (
                <span className="text-xs text-neutral-500">{t('users.allBranches')}</span>
              ) : (
                <span className="text-xs text-neutral-700">{branchNamesOf(u).join('، ')}</span>
              ),
          },
          {
            key: 'lastLogin',
            header: t('users.lastLogin'),
            className: 'numeric',
            cell: (u) => (u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('users.neverSignedIn')),
          },
          {
            key: 'status',
            header: t('users.status'),
            cell: (u) => (
              <Badge tone={userStatusTone(u.status)}>{t(u.status === 'ACTIVE' ? 'users.active' : 'users.suspended_label')}</Badge>
            ),
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
                {canEdit && u.status === 'ACTIVE' && (
                  <Button size="sm" variant="ghost" onClick={() => setResetting(u)} data-testid={`reset-user-${u.id}`}>
                    {t('users.resetPassword')}
                  </Button>
                )}
                {canEdit && u.status === 'SUSPENDED' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={reactivate.isPending}
                    onClick={() => reactivate.mutate(u)}
                    data-testid={`reactivate-user-${u.id}`}
                  >
                    {t('users.reactivate')}
                  </Button>
                )}
                {canSuspend && u.status === 'ACTIVE' && (
                  <Button size="sm" variant="ghost" onClick={() => setSuspending(u)} data-testid={`suspend-user-${u.id}`}>
                    {t('users.suspend')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      {(creating || editing) && (
        <UserDialog
          user={editing}
          roles={roles.data?.data ?? []}
          branches={branches.data?.data ?? []}
          canSeeRoles={canSeeRoles}
          canSeeBranches={canSeeBranches}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onError={fail}
          onSaved={async () => {
            const wasEditing = Boolean(editing);
            setCreating(false);
            setEditing(null);
            await refresh(t(wasEditing ? 'users.updated' : 'users.created'));
          }}
        />
      )}

      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onError={(e) => {
            setResetting(null);
            fail(e);
          }}
          onDone={async (revokedSessions) => {
            setResetting(null);
            await refresh(t('users.passwordReset', { count: revokedSessions }));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(suspending)}
        tone="danger"
        title={t('users.suspendTitle')}
        message={t('users.suspendWarning', { name: suspending?.name ?? '' })}
        confirmLabel={t('users.suspend')}
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
 * Create and edit share one dialog because the backend fields are the
 * same set minus two: a new user needs an email and a password, and
 * neither is editable afterwards — there is no email-change endpoint and
 * a password change is its own permissioned act.
 */
function UserDialog({
  user,
  roles,
  branches,
  canSeeRoles,
  canSeeBranches,
  onClose,
  onSaved,
  onError,
}: {
  user: AdminUser | null;
  roles: Role[];
  branches: Branch[];
  canSeeRoles: boolean;
  canSeeBranches: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>(user?.userRoles.map((ur) => ur.role.id) ?? []);
  const [branchIds, setBranchIds] = useState<string[]>(user?.userBranches.map((ub) => ub.branch.id) ?? []);

  const save = useMutation({
    mutationFn: () =>
      user
        ? adminApi.updateUser(user.id, {
            name: name.trim(),
            // Role and branch assignment is only sent by a caller who could
            // see the pickers at all; otherwise the existing assignment is
            // left exactly as it was rather than being replaced by [].
            ...(canSeeRoles ? { roleIds } : {}),
            ...(canSeeBranches ? { branchIds } : {}),
          })
        : adminApi.createUser({
            name: name.trim(),
            email: email.trim(),
            password,
            roleIds,
            branchIds,
          }),
    onSuccess: onSaved,
    onError,
  });

  function toggle(list: string[], id: string, set: (next: string[]) => void) {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  return (
    <ConfirmDialog
      open
      title={t(user ? 'users.editUser' : 'users.newUser')}
      confirmLabel={t(user ? 'common.save' : 'common.create')}
      cancelLabel={t('common.cancel')}
      pending={save.isPending}
      onConfirm={() => save.mutate()}
      onClose={onClose}
      data-testid="user-dialog"
    >
      <Input label={t('users.name')} value={name} onChange={(e) => setName(e.target.value)} data-testid="user-name" />
      {!user && (
        <>
          <Input
            label={t('users.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="user-email"
          />
          <Input
            label={t('users.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={t('users.passwordHint')}
            data-testid="user-password"
          />
        </>
      )}
      {user && <p className="text-xs text-neutral-500">{t('users.emailFixed', { email: user.email })}</p>}

      {canSeeRoles && (
        <CheckboxGroup
          label={t('users.roles')}
          hint={t('users.rolesHint')}
          testId="user-roles"
          options={roles.map((r) => ({ id: r.id, label: r.name }))}
          selected={roleIds}
          onToggle={(id) => toggle(roleIds, id, setRoleIds)}
        />
      )}
      {canSeeBranches && (
        <CheckboxGroup
          label={t('users.branches')}
          hint={t('users.branchesHint')}
          testId="user-branches"
          options={branches.map((b) => ({ id: b.id, label: b.name }))}
          selected={branchIds}
          onToggle={(id) => toggle(branchIds, id, setBranchIds)}
        />
      )}
    </ConfirmDialog>
  );
}

// ====================================================================
function ResetPasswordDialog({
  user,
  onClose,
  onDone,
  onError,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: (revokedSessions: number) => void | Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');

  const reset = useMutation({
    mutationFn: () => adminApi.resetUserPassword(user.id, password),
    onSuccess: (res) => onDone(res.data.revokedSessions),
    onError,
  });

  return (
    <ConfirmDialog
      open
      tone="danger"
      title={t('users.resetPasswordTitle', { name: user.name })}
      message={t('users.resetPasswordWarning')}
      confirmLabel={t('users.resetPassword')}
      cancelLabel={t('common.cancel')}
      pending={reset.isPending}
      onConfirm={() => reset.mutate()}
      onClose={onClose}
      data-testid="reset-password-dialog"
    >
      <Input
        label={t('users.newPassword')}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={t('users.passwordHint')}
        data-testid="new-password"
      />
    </ConfirmDialog>
  );
}

// ====================================================================
/** Multi-select as checkboxes rather than a native multiple-select: a
 *  touch target that works at 390px and reads correctly in both
 *  directions, which `<select multiple>` does neither of. */
function CheckboxGroup({
  label,
  hint,
  options,
  selected,
  onToggle,
  testId,
}: {
  label: string;
  hint?: string;
  options: { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-neutral-700">{label}</p>
      <div
        className="max-h-40 overflow-y-auto rounded-lg border border-neutral-200 p-2"
        data-testid={testId}
      >
        {options.length === 0 && <p className="p-1 text-xs text-neutral-400">{t('common.noResults')}</p>}
        {options.map((option) => (
          <label key={option.id} className="flex items-center gap-2 py-1 text-sm text-neutral-800">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-600"
              checked={selected.includes(option.id)}
              onChange={() => onToggle(option.id)}
              data-testid={`${testId}-${option.id}`}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {hint && <p className="mt-1 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}
