import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, DataTable, ErrorBanner, Input, Modal, Select } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { describeError } from '../lib/apiClient';
import { formatDateTime } from '../lib/datetime';
import { auditActionTone, auditActorLabel, auditSnapshot, auditTotalPages } from '../lib/admin';
import { pageWindow } from '../lib/catalogue';
import { usePermission } from '../hooks/usePermission';
import type { AuditAction, AuditLogRow } from '../lib/apiTypes';

/** Exactly the actions the backend's enum accepts. Sending anything else
 *  is a 422, so the filter is a closed list rather than free text. */
const ACTIONS: AuditAction[] = ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PERMISSION_DENIED'];

/**
 * Phase 20 — THE TRAIL, READABLE AT LAST FROM THE BACK OFFICE.
 *
 * READ-ONLY BY CONSTRUCTION, not by convention: the database grants the
 * API's role SELECT and INSERT on `audit_logs` and nothing else, so there
 * is no edit or delete endpoint for this screen to call and there could
 * not be one.
 *
 * EVERY FILTER HERE IS THE SERVER'S. `GET /audit-logs` takes `userId`,
 * `action`, `entityType`, `entityId`, `requestId`, `from`, `to`, `page`
 * and `limit` — this screen offers those and not one field more. Nothing
 * is narrowed, counted or sorted in the browser; the ordering
 * (`createdAt` then `id`) is the server's too, and deliberately so, because
 * several rows written in one transaction share a timestamp and paging on
 * it alone would skip and repeat rows.
 *
 * `requestId` IS THE ONE THAT MATTERS IN AN INVESTIGATION. It correlates
 * every row written while serving one request, so a reviewer who finds one
 * suspicious row can pull the whole action around it — which is why it is
 * a filter AND a one-click link from any row that carries it.
 *
 * WHO DID IT is resolved against the user list only when the caller may
 * read one. A reviewer holding `audit.view` without `users.view` sees the
 * raw id rather than a blank — an unresolvable actor is still evidence.
 */
export function AuditLogPage() {
  const { t } = useTranslation();
  const canSeeUsers = usePermission('users.view');

  const [filters, setFilters] = useState({
    userId: '',
    action: '' as '' | AuditAction,
    entityType: '',
    entityId: '',
    requestId: '',
    from: '',
    to: '',
  });
  const [page, setPage] = useState(1);
  const [inspecting, setInspecting] = useState<AuditLogRow | null>(null);

  const query = {
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.entityType.trim() ? { entityType: filters.entityType.trim() } : {}),
    ...(filters.entityId.trim() ? { entityId: filters.entityId.trim() } : {}),
    ...(filters.requestId.trim() ? { requestId: filters.requestId.trim() } : {}),
    // The API takes date strings; a browser date input gives `YYYY-MM-DD`,
    // which `new Date()` reads as midnight UTC on the server side.
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    page,
  };

  const logs = useQuery({
    queryKey: ['admin', 'audit-logs', query],
    queryFn: () => adminApi.listAuditLogs(query),
    placeholderData: keepPreviousData,
  });
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => adminApi.listUsers(),
    enabled: canSeeUsers,
  });

  function set<K extends keyof typeof filters>(key: K, value: (typeof filters)[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  const rows = logs.data?.data ?? [];
  const meta = logs.data?.meta;
  const totalPages = meta ? auditTotalPages(meta) : 1;
  const userList = users.data?.data;

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('audit.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('audit.explainer')}</p>

      <Card className="mb-4">
        <CardBody className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {canSeeUsers ? (
            <Select
              label={t('audit.user')}
              value={filters.userId}
              onChange={(e) => set('userId', e.target.value)}
              data-testid="audit-user"
            >
              <option value="">{t('audit.anyUser')}</option>
              {(userList ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          ) : (
            // No user list to pick from, so the raw id is accepted — the
            // filter is the server's either way.
            <Input
              label={t('audit.userId')}
              value={filters.userId}
              onChange={(e) => set('userId', e.target.value)}
              placeholder={t('audit.userIdHint')}
              data-testid="audit-user-id"
            />
          )}
          <Select
            label={t('audit.action')}
            value={filters.action}
            onChange={(e) => set('action', e.target.value as '' | AuditAction)}
            data-testid="audit-action"
          >
            <option value="">{t('audit.anyAction')}</option>
            {ACTIONS.map((action) => (
              <option key={action} value={action}>
                {t(`audit.actions.${action}`)}
              </option>
            ))}
          </Select>
          <Input
            label={t('audit.entityType')}
            value={filters.entityType}
            onChange={(e) => set('entityType', e.target.value)}
            placeholder={t('audit.entityTypeHint')}
            data-testid="audit-entity-type"
          />
          <Input
            label={t('audit.entityId')}
            value={filters.entityId}
            onChange={(e) => set('entityId', e.target.value)}
            data-testid="audit-entity-id"
          />
          <Input
            label={t('audit.requestId')}
            value={filters.requestId}
            onChange={(e) => set('requestId', e.target.value)}
            hint={t('audit.requestIdHint')}
            data-testid="audit-request-id"
          />
          <Input
            label={t('audit.from')}
            type="date"
            value={filters.from}
            onChange={(e) => set('from', e.target.value)}
            data-testid="audit-from"
          />
          <Input
            label={t('audit.to')}
            type="date"
            value={filters.to}
            onChange={(e) => set('to', e.target.value)}
            data-testid="audit-to"
          />
          <div className="flex items-end">
            <Button
              variant="secondary"
              onClick={() => {
                setFilters({ userId: '', action: '', entityType: '', entityId: '', requestId: '', from: '', to: '' });
                setPage(1);
              }}
              data-testid="audit-clear"
            >
              {t('audit.clearFilters')}
            </Button>
          </div>
        </CardBody>
      </Card>

      {logs.isError && <ErrorBanner {...describeError(logs.error)} />}

      <DataTable
        data-testid="audit-table"
        loading={logs.isLoading}
        rows={rows}
        rowKey={(r) => r.id}
        empty={t('audit.none')}
        onRowClick={(r) => setInspecting(r)}
        columns={[
          {
            key: 'when',
            header: t('audit.when'),
            className: 'numeric',
            cell: (r: AuditLogRow) => formatDateTime(r.createdAt),
          },
          {
            key: 'action',
            header: t('audit.action'),
            cell: (r) => <Badge tone={auditActionTone(r.action)}>{t(`audit.actions.${r.action}`)}</Badge>,
          },
          {
            key: 'who',
            header: t('audit.user'),
            cell: (r) => auditActorLabel(r, userList) ?? <span className="text-neutral-400">{t('audit.system')}</span>,
          },
          {
            key: 'what',
            header: t('audit.entity'),
            cell: (r) => (
              <div className="min-w-0">
                <p className="font-semibold text-neutral-900">{r.entityType}</p>
                {r.entityId && <p className="truncate font-mono text-xs text-neutral-500">{r.entityId}</p>}
              </div>
            ),
          },
          {
            key: 'reason',
            header: t('audit.reason'),
            cell: (r) => r.reason ?? '—',
          },
        ]}
      />

      {meta && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="audit-pagination">
          <p className="text-xs text-neutral-500">
            {t('audit.pageOf', { page: meta.page, totalPages, total: meta.total })}
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={meta.page <= 1} onClick={() => setPage(meta.page - 1)}>
                {t('catalogue.previous')}
              </Button>
              {pageWindow(meta.page, totalPages).map((p) => (
                <Button key={p} size="sm" variant={p === meta.page ? 'primary' : 'ghost'} onClick={() => setPage(p)}>
                  {String(p)}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                disabled={meta.page >= totalPages}
                onClick={() => setPage(meta.page + 1)}
              >
                {t('catalogue.next')}
              </Button>
            </div>
          )}
        </div>
      )}

      {inspecting && (
        <AuditDetail
          row={inspecting}
          actor={auditActorLabel(inspecting, userList)}
          onClose={() => setInspecting(null)}
          onFollowRequest={(requestId) => {
            setInspecting(null);
            setFilters({ userId: '', action: '', entityType: '', entityId: '', requestId, from: '', to: '' });
            setPage(1);
          }}
        />
      )}
    </div>
  );
}

// ====================================================================
/**
 * One row, in full.
 *
 * `before` and `after` are whatever the module that wrote the row put
 * there, so they are rendered as formatted JSON rather than through a
 * shape this screen would have to invent — and omitted entirely when
 * empty, because a `{}` panel tells a reviewer nothing.
 */
function AuditDetail({
  row,
  actor,
  onClose,
  onFollowRequest,
}: {
  row: AuditLogRow;
  actor: string | null;
  onClose: () => void;
  onFollowRequest: (requestId: string) => void;
}) {
  const { t } = useTranslation();
  const before = auditSnapshot(row.before);
  const after = auditSnapshot(row.after);

  return (
    <Modal open onClose={onClose} size="lg" title={t('audit.detailTitle')}>
      <div className="flex flex-col gap-3" data-testid="audit-detail">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <Field label={t('audit.when')} value={formatDateTime(row.createdAt)} />
          <Field label={t('audit.action')} value={t(`audit.actions.${row.action}`)} />
          <Field label={t('audit.user')} value={actor ?? t('audit.system')} />
          <Field label={t('audit.entity')} value={`${row.entityType}${row.entityId ? ` · ${row.entityId}` : ''}`} />
          <Field label={t('audit.ipAddress')} value={row.ipAddress ?? '—'} />
          <Field label={t('audit.requestId')} value={row.requestId ?? '—'} />
          {row.reason && <Field label={t('audit.reason')} value={row.reason} />}
          {row.userAgent && <Field label={t('audit.userAgent')} value={row.userAgent} />}
        </dl>

        {row.requestId && (
          <Button
            variant="secondary"
            onClick={() => onFollowRequest(row.requestId!)}
            data-testid="audit-follow-request"
          >
            {t('audit.showWholeRequest')}
          </Button>
        )}

        {before && <Snapshot label={t('audit.before')} json={before} testId="audit-before" />}
        {after && <Snapshot label={t('audit.after')} json={after} testId="audit-after" />}
        {!before && !after && <p className="text-xs text-neutral-500">{t('audit.noSnapshot')}</p>}

        <Button variant="secondary" fullWidth onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </Modal>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="break-words font-medium text-neutral-900">{value}</dd>
    </div>
  );
}

function Snapshot({ label, json, testId }: { label: string; json: string; testId: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-neutral-700">{label}</p>
      {/* Scrolls inside its own box: a long snapshot must never push the
          page sideways, in either direction. `dir="ltr"` because JSON is
          not Arabic text and reads wrong when mirrored. */}
      <pre
        dir="ltr"
        className="max-h-56 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-start font-mono text-xs text-neutral-800"
        data-testid={testId}
      >
        {json}
      </pre>
    </div>
  );
}
