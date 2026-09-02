import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, DataTable, ErrorBanner, Input, Select } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { describeError } from '../lib/apiClient';
import { formatDateTime } from '../lib/datetime';
import { auditTone, hasAuditPayload, redactAuditPayload } from '../lib/admin';
import { usePermission } from '../hooks/usePermission';
import type { AuditAction, AuditLogRow } from '../lib/apiTypes';

/**
 * Phase 20 — AUDIT LOG, READ ONLY.
 *
 * NO AUDIT SYSTEM WAS BUILT HERE. `AuditService` already records every
 * CREATE/UPDATE/DELETE with before/after JSON, the actor, the IP, the
 * user-agent and the request id — verified during discovery for User,
 * Role, Branch, Warehouse, Business and Setting. This screen reads it.
 *
 * THE FILTERS ARE THE SERVER'S SEVEN, and only those: userId, action,
 * entityType, entityId, requestId, from, to. Nothing is narrowed in the
 * browser.
 *
 * BEFORE/AFTER IS REDACTED ON THE WAY TO THE SCREEN. The server never
 * writes a password, a hash or a token into an audit payload — the
 * password-change path deliberately records that a change happened and
 * nothing about the value. `redactAuditPayload` masks anything
 * credential-shaped anyway, because an audit viewer is the last place
 * that should be the only thing standing between a future logging
 * mistake and a rendered secret.
 */
const ACTIONS: AuditAction[] = ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PERMISSION_DENIED'];

export function AdminAuditPage() {
  const { t } = useTranslation();
  const canViewUsers = usePermission('users.view');

  const [action, setAction] = useState<'' | AuditAction>('');
  const [entityType, setEntityType] = useState('');
  const [requestId, setRequestId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const filters = {
    action: action || undefined,
    entityType: entityType.trim() || undefined,
    requestId: requestId.trim() || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
  };
  const logs = useQuery({
    queryKey: ['audit-logs', filters],
    queryFn: () => adminApi.listAuditLogs(filters),
    placeholderData: keepPreviousData,
  });
  // Only to show a name instead of a bare actor id.
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => adminApi.listUsers(), enabled: canViewUsers });
  const actorName = (id: string | null) =>
    id ? (users.data?.data.find((u) => u.id === id)?.name ?? id) : t('admin.audit.system');

  const rows = logs.data?.data ?? [];
  const meta = logs.data?.meta;
  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1;

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('admin.audit.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('admin.audit.explainer')}</p>

      <Card className="mb-4">
        <CardBody className="p-3">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label={t('admin.audit.action')}
              value={action}
              onChange={(e) => {
                setAction(e.target.value as '' | AuditAction);
                setPage(1);
              }}
              data-testid="audit-action"
            >
              <option value="">{t('admin.audit.allActions')}</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`admin.audit.actionLabel.${a}`)}
                </option>
              ))}
            </Select>
            <Input
              label={t('admin.audit.entityType')}
              value={entityType}
              onChange={(e) => {
                setEntityType(e.target.value);
                setPage(1);
              }}
              placeholder={t('admin.audit.entityTypeHint')}
              data-testid="audit-entity-type"
            />
            <Input
              label={t('admin.audit.requestId')}
              value={requestId}
              onChange={(e) => {
                setRequestId(e.target.value);
                setPage(1);
              }}
              data-testid="audit-request-id"
            />
            <Input label={t('reports.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="audit-from" />
            <Input label={t('reports.to')} type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="audit-to" />
          </div>
          <p className="mt-2 text-xs text-neutral-500">{t('admin.audit.filtersHint')}</p>
        </CardBody>
      </Card>

      {logs.isError && <ErrorBanner {...describeError(logs.error)} />}

      <DataTable
        data-testid="audit-table"
        loading={logs.isLoading}
        rows={rows}
        rowKey={(r) => r.id}
        empty={t('admin.audit.none')}
        onRowClick={(r) => setExpanded(expanded === r.id ? null : r.id)}
        columns={[
          { key: 'when', header: t('admin.audit.when'), cell: (r: AuditLogRow) => formatDateTime(r.createdAt) },
          { key: 'actor', header: t('admin.audit.actor'), cell: (r) => actorName(r.userId) },
          {
            key: 'action',
            header: t('admin.audit.action'),
            cell: (r) => <Badge tone={auditTone(r.action)}>{t(`admin.audit.actionLabel.${r.action}`)}</Badge>,
          },
          { key: 'entity', header: t('admin.audit.entity'), cell: (r) => r.entityType },
          { key: 'entityId', header: t('admin.audit.entityId'), className: 'numeric', cell: (r) => r.entityId ?? '—' },
          { key: 'ip', header: t('admin.audit.ip'), className: 'numeric', cell: (r) => r.ipAddress ?? '—' },
          {
            key: 'details',
            header: '',
            align: 'end',
            cell: (r) =>
              hasAuditPayload(r) ? (
                <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === r.id ? null : r.id)} data-testid={`audit-expand-${r.id}`}>
                  {t(expanded === r.id ? 'admin.audit.hide' : 'admin.audit.details')}
                </Button>
              ) : (
                '—'
              ),
          },
        ]}
      />

      {expanded && rows.some((r) => r.id === expanded) && (
        <Card className="mt-3">
          <CardBody className="p-4" data-testid="audit-detail">
            {(() => {
              const row = rows.find((r) => r.id === expanded)!;
              return (
                <>
                  <p className="mb-2 text-xs text-neutral-500">
                    {t('admin.audit.requestId')}: <span className="numeric">{row.requestId ?? '—'}</span>
                    {row.userAgent && <span className="ms-3">{row.userAgent}</span>}
                  </p>
                  {row.reason && <p className="mb-2 text-xs text-neutral-600">{row.reason}</p>}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Payload label={t('admin.audit.before')} value={row.before} testId="audit-before" />
                    <Payload label={t('admin.audit.after')} value={row.after} testId="audit-after" />
                  </div>
                </>
              );
            })()}
          </CardBody>
        </Card>
      )}

      {meta && totalPages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="audit-pager">
          <p className="text-xs text-neutral-500">{t('reports.pageOf', { page: meta.page, totalPages, total: meta.total })}</p>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={meta.page <= 1} onClick={() => setPage(meta.page - 1)}>
              {t('catalogue.previous')}
            </Button>
            <Button size="sm" variant="ghost" disabled={meta.page >= totalPages} onClick={() => setPage(meta.page + 1)}>
              {t('catalogue.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Redacted before it is ever rendered — see the note at the top. */
function Payload({ label, value, testId }: { label: string; value: unknown; testId: string }) {
  const { t } = useTranslation();
  if (value === null || value === undefined) {
    return (
      <div>
        <p className="mb-1 text-xs font-semibold text-neutral-700">{label}</p>
        <p className="text-xs text-neutral-400">{t('admin.audit.nothing')}</p>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-neutral-700">{label}</p>
      <pre
        className="numeric max-h-64 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-[11px] leading-snug text-neutral-700"
        data-testid={testId}
      >
        {JSON.stringify(redactAuditPayload(value), null, 2)}
      </pre>
    </div>
  );
}
