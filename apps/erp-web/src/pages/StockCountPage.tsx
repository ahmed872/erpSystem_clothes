import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Spinner } from '@retail/ui-kit';
import { inventoryApi } from '../api/inventory';
import { describeError } from '../lib/apiClient';
import { formatDateTime } from '../lib/datetime';
import { canApproveCount, canEditCount, canSubmitCount, countTone, countVariance } from '../lib/inventory';
import { usePermission } from '../hooks/usePermission';
import type { StockCountItem } from '../lib/apiTypes';

/**
 * Phase 15 — a physical stock count.
 *
 * THE TWO-PERSON RULE IS THE BACKEND'S, AND IT IS THE POINT. Counting is
 * `inventory.stock_count_create`; APPROVING is
 * `inventory.stock_count_approve`, a separate grant — and approval is the
 * call that actually moves stock to match what was counted. A
 * BRANCH_MANAGER holds approve and NOT create: they sign off a count
 * somebody else performed. This screen keeps the two controls apart
 * because the server does.
 *
 * EXPECTED QUANTITIES ARE A SNAPSHOT taken when the count was created,
 * stored per line by the server. The variance shown is `actual −
 * expected` from those two stored figures; it is not a live comparison
 * against current stock, and this screen does not refresh it into one.
 *
 * KNOWN LIMITATION, reported rather than papered over: there is no
 * `GET /inventory/stock-counts` list endpoint in the live backend, only
 * `GET /inventory/stock-counts/:id`. A count is therefore reachable by
 * its URL, which the create flow navigates to; there is no "my open
 * counts" screen because there is no contract to build one on.
 */
export function StockCountPage() {
  const { t } = useTranslation();
  const { countId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canCount = usePermission('inventory.stock_count_create');
  const canApprove = usePermission('inventory.stock_count_approve');

  const [counted, setCounted] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const detail = useQuery({ queryKey: ['stock-count', countId], queryFn: () => inventoryApi.getCount(countId) });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['stock-count', countId] });
    await queryClient.invalidateQueries({ queryKey: ['balances'] });
    await queryClient.invalidateQueries({ queryKey: ['movements'] });
  }
  function fail(e: unknown) {
    setOk(null);
    setError(describeError(e));
  }

  const saveItems = useMutation({
    mutationFn: () =>
      inventoryApi.submitCountItems(
        countId,
        Object.entries(counted)
          .filter(([, v]) => v !== '')
          .map(([variantId, v]) => ({
            variantId,
            actualQuantity: Number(v),
            ...(reasons[variantId]?.trim() ? { reason: reasons[variantId].trim() } : {}),
          })),
      ),
    onSuccess: async () => {
      setError(null);
      setOk(t('counts.saved'));
      await refresh();
    },
    onError: fail,
  });

  const submit = useMutation({
    mutationFn: () => inventoryApi.submitCount(countId),
    onSuccess: async () => {
      setSubmitting(false);
      setError(null);
      setOk(t('counts.submitted'));
      await refresh();
    },
    onError: fail,
  });

  const approve = useMutation({
    mutationFn: () => inventoryApi.approveCount(countId),
    onSuccess: async () => {
      setApproving(false);
      setError(null);
      setOk(t('counts.approved'));
      await refresh();
    },
    onError: fail,
  });

  if (detail.isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="mx-auto max-w-4xl p-4">
        <ErrorBanner {...describeError(detail.error)} />
      </div>
    );
  }

  const count = detail.data!.data;
  const editable = canCount && canEditCount(count);

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold text-neutral-900">{t('counts.title')}</h1>
            <Badge tone={countTone(count.status)}>{t(`counts.statusLabel.${count.status}`)}</Badge>
          </div>
          <p className="text-xs text-neutral-500">{count.warehouse?.name ?? ''}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/inventory')}>
          {t('counts.backToInventory')}
        </Button>
      </div>

      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('counts.explainer')}</p>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="count-result">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}

      <Card className="mb-4">
        <CardBody className="grid grid-cols-1 gap-x-6 gap-y-1 p-4 sm:grid-cols-2">
          <Fact label={t('counts.created')} value={formatDateTime(count.createdAt)} />
          <Fact label={t('counts.submittedAt')} value={count.submittedAt ? formatDateTime(count.submittedAt) : '—'} />
          <Fact label={t('counts.approvedAt')} value={count.approvedAt ? formatDateTime(count.approvedAt) : '—'} />
        </CardBody>
      </Card>

      <DataTable
        data-testid="count-items"
        rows={count.items}
        rowKey={(i) => i.id}
        empty={t('counts.noItems')}
        columns={[
          { key: 'sku', header: t('catalogue.sku'), className: 'numeric', cell: (i: StockCountItem) => i.variant?.sku ?? i.variantId },
          {
            key: 'expected',
            header: t('counts.expected'),
            align: 'end',
            className: 'numeric',
            cell: (i) => i.expectedQuantity,
          },
          {
            key: 'actual',
            header: t('counts.actual'),
            align: 'end',
            className: 'numeric',
            cell: (i) =>
              editable ? (
                <Input
                  type="number"
                  min="0"
                  step="0.0001"
                  placeholder={i.actualQuantity ?? ''}
                  value={counted[i.variantId] ?? ''}
                  onChange={(e) => setCounted({ ...counted, [i.variantId]: e.target.value })}
                  className="w-28"
                  data-testid={`count-actual-${i.variant?.sku ?? i.variantId}`}
                />
              ) : (
                (i.actualQuantity ?? '—')
              ),
          },
          {
            key: 'variance',
            header: t('counts.variance'),
            align: 'end',
            className: 'numeric',
            // From the two figures the SERVER stored. Null until counted —
            // never a 0, which would read as "counted and matched".
            cell: (i) => {
              const v = countVariance(i);
              if (v === null) return '—';
              return <span className={v === 0 ? '' : v > 0 ? 'text-success-700' : 'text-danger-700'}>{v}</span>;
            },
          },
          {
            key: 'reason',
            header: t('counts.reason'),
            cell: (i) =>
              editable ? (
                <Input
                  value={reasons[i.variantId] ?? ''}
                  onChange={(e) => setReasons({ ...reasons, [i.variantId]: e.target.value })}
                  data-testid={`count-reason-${i.variant?.sku ?? i.variantId}`}
                />
              ) : (
                (i.reason ?? '—')
              ),
          },
        ]}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        {editable && (
          <Button
            variant="secondary"
            loading={saveItems.isPending}
            disabled={saveItems.isPending || Object.values(counted).every((v) => v === '')}
            onClick={() => saveItems.mutate()}
            data-testid="save-count"
          >
            {t('counts.saveCounts')}
          </Button>
        )}
        {canCount && canSubmitCount(count) && (
          <Button onClick={() => setSubmitting(true)} data-testid="submit-count">
            {t('counts.submit')}
          </Button>
        )}
        {/* A SECOND grant, and the call that actually moves stock. */}
        {canApprove && canApproveCount(count) && (
          <Button onClick={() => setApproving(true)} data-testid="approve-count">
            {t('counts.approve')}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={submitting}
        title={t('counts.submit')}
        message={t('counts.submitWarning')}
        confirmLabel={t('counts.submit')}
        cancelLabel={t('common.cancel')}
        pending={submit.isPending}
        onConfirm={() => submit.mutate()}
        onClose={() => setSubmitting(false)}
        data-testid="submit-count-dialog"
      />

      <ConfirmDialog
        open={approving}
        tone="danger"
        title={t('counts.approve')}
        message={t('counts.approveWarning')}
        confirmLabel={t('counts.approve')}
        cancelLabel={t('common.cancel')}
        pending={approve.isPending}
        onConfirm={() => approve.mutate()}
        onClose={() => setApproving(false)}
        data-testid="approve-count-dialog"
      />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-neutral-100 py-1 text-sm last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className="font-medium text-neutral-800">{value}</span>
    </div>
  );
}
