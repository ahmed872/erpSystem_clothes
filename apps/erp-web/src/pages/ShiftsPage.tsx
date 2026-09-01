import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, DataTable, ErrorBanner, Input, Spinner } from '@retail/ui-kit';
import { shiftsApi } from '../api/shifts';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDateTime } from '../lib/datetime';
import { isReconcilable, shiftUiState, varianceKind } from '../lib/shiftReview';
import { usePermission } from '../hooks/usePermission';
import type { Shift } from '../lib/apiTypes';

/**
 * Phase 13 (ERP slice) — RECONCILING A CLOSED SHIFT.
 *
 * The second act the POS deliberately excluded. A cashier closes blind:
 * they count the drawer, submit the figure, and never see what the
 * documents said it should be. Someone else has to look at the variance
 * and accept it — that person is here, and until now had no screen at all.
 *
 * NOTHING ON THIS PAGE COMPUTES CASH. Expected cash is
 * `openingFloat + SUM(cash_transactions.amount)`, derived server-side and
 * never stored; the variance is `countedCash - expectedCash`, also
 * server-side, and it reached the ledger at CLOSE, not here.
 * Reconciliation is an ACKNOWLEDGEMENT: it records who accepted the
 * variance and when, and there is no field on the request — and no code
 * path in the backend — that could alter the cashier's counted amount or
 * re-post the entry. `lib/shiftReview.ts` deliberately provides no
 * `expectedCash()` for the same reason the POS refuses to.
 *
 * WHY THE FIGURES ARE VISIBLE HERE AT ALL. The server strips
 * `expectedCash`/`variance`/`cashIn`/`cashOut` for anyone without
 * `shifts.view_expected`. A reconciler holds it, so their response carries
 * them — this screen renders what arrived and performs no permission
 * branch of its own.
 */
export function ShiftsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canReconcile = usePermission('shifts.reconcile');

  const [selected, setSelected] = useState<Shift | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [result, setResult] = useState<Shift | null>(null);

  const shifts = useQuery({ queryKey: ['shifts'], queryFn: () => shiftsApi.list() });
  const registers = useQuery({ queryKey: ['registers'], queryFn: () => shiftsApi.registers() });
  const registerName = (id: string) => {
    const r = registers.data?.data.find((x) => x.id === id);
    return r ? `${r.name} (${r.code})` : '—';
  };

  async function handleReconcile() {
    if (!selected) return;
    setPending(true);
    setError(null);
    try {
      const { data } = await shiftsApi.reconcile(selected.id, note.trim() || undefined);
      // The AUTHORITATIVE result: the shift as the server returned it,
      // with its own reconciledBy/reconciledAt and its own cash figures.
      setResult(data);
      setSelected(data);
      setConfirming(false);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['shifts'] });
    } catch (err) {
      // Already reconciled, or still open. The server's message is the
      // whole explanation.
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  const rows = shifts.data?.data ?? [];

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('shifts.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('shifts.explainer')}</p>

      {shifts.isError && <ErrorBanner {...describeError(shifts.error)} />}

      <DataTable
        data-testid="shifts-table"
        loading={shifts.isLoading}
        rows={rows}
        rowKey={(s) => s.id}
        empty={t('shifts.none')}
        onRowClick={(s) => {
          setSelected(s);
          setResult(null);
          setError(null);
        }}
        isRowActive={(s) => s.id === selected?.id}
        columns={[
          { key: 'register', header: t('shifts.register'), cell: (s: Shift) => registerName(s.cashRegisterId) },
          { key: 'opened', header: t('shifts.openedAt'), cell: (s) => formatDateTime(s.openedAt) },
          { key: 'closed', header: t('shifts.closedAt'), cell: (s) => (s.closedAt ? formatDateTime(s.closedAt) : '—') },
          {
            key: 'counted',
            header: t('shifts.countedCash'),
            align: 'end',
            className: 'numeric',
            cell: (s) => (s.countedCash === null ? '—' : formatMoney(s.countedCash)),
          },
          {
            key: 'state',
            header: t('shifts.state'),
            cell: (s) => {
              const state = shiftUiState(s);
              return (
                <Badge tone={state === 'OPEN' ? 'brand' : state === 'AWAITING_RECONCILIATION' ? 'warning' : 'success'}>
                  {t(`shifts.stateLabel.${state}`)}
                </Badge>
              );
            },
          },
        ]}
      />

      {selected && (
        <Card className="mt-4">
          <CardBody className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-bold text-neutral-900">{registerName(selected.cashRegisterId)}</p>
                <p className="text-xs text-neutral-500">
                  {t('shifts.openedAt')}: {formatDateTime(selected.openedAt)}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                {t('common.close')}
              </Button>
            </div>

            <div className="rounded-lg bg-neutral-50 p-3">
              <Row label={t('shifts.openingFloat')} value={formatMoney(selected.openingFloat)} />
              {/* Rendered ONLY because the server sent them, i.e. only for a
                  holder of `shifts.view_expected`. */}
              {selected.cashIn !== undefined && <Row label={t('shifts.cashIn')} value={formatMoney(selected.cashIn)} />}
              {selected.cashOut !== undefined && <Row label={t('shifts.cashOut')} value={formatMoney(selected.cashOut)} />}
              {selected.expectedCash !== undefined && (
                <Row label={t('shifts.expectedCash')} value={formatMoney(selected.expectedCash)} testId="detail-expected" />
              )}
              <Row
                label={t('shifts.countedCash')}
                value={selected.countedCash === null ? '—' : formatMoney(selected.countedCash)}
                testId="detail-counted"
              />
              <VarianceRow variance={selected.variance} />
            </div>

            {error && <ErrorBanner title={error.title} message={error.message} />}

            {result && (
              <div className="rounded-lg border border-success-200 bg-success-50 p-3" data-testid="reconcile-result">
                <p className="text-sm font-semibold text-success-700">{t('shifts.reconciledTitle')}</p>
                <p className="mt-0.5 text-xs text-neutral-600">
                  {formatDateTime(result.reconciledAt)}
                  {result.reconciliationNote ? ` · ${result.reconciliationNote}` : ''}
                </p>
              </div>
            )}

            {canReconcile && isReconcilable(selected) && (
              <Button className="self-start" onClick={() => setConfirming(true)} data-testid="reconcile-action">
                {t('shifts.reconcileAction')}
              </Button>
            )}
            {selected.reconciledAt && <p className="text-xs text-neutral-500">{t('shifts.alreadyReconciled')}</p>}
          </CardBody>
        </Card>
      )}

      <ConfirmDialog
        open={confirming}
        title={t('shifts.reconcileTitle')}
        message={t('shifts.reconcileWarning')}
        confirmLabel={t('shifts.reconcileSubmit')}
        cancelLabel={t('common.cancel')}
        pending={pending}
        onConfirm={() => void handleReconcile()}
        onClose={() => setConfirming(false)}
        data-testid="reconcile-dialog"
      >
        <Input
          label={t('shifts.reconcileNote')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          data-testid="reconcile-note"
        />
      </ConfirmDialog>

      {registers.isLoading && <Spinner />}
    </div>
  );
}

/** The server's variance, classified only by its SIGN so a manager reads
 *  words rather than a minus. Absent entirely when the caller was not sent
 *  one — never rendered as a zero, which would read as "balanced". */
function VarianceRow({ variance }: { variance: string | null | undefined }) {
  const { t } = useTranslation();
  const kind = varianceKind(variance);
  if (!kind) return null;
  return (
    <div className="mt-1 flex items-baseline justify-between border-t border-neutral-200 pt-1 text-sm">
      <span className="text-neutral-500">{t('shifts.variance')}</span>
      <span
        className={`numeric font-bold ${
          kind === 'SHORTAGE' ? 'text-danger-700' : kind === 'OVERAGE' ? 'text-warning-700' : 'text-success-700'
        }`}
        data-testid="detail-variance"
      >
        {formatMoney(variance)} · {t(`shifts.varianceKind.${kind}`)}
      </span>
    </div>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-neutral-500">{label}</span>
      <span className="numeric font-semibold text-neutral-800" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
