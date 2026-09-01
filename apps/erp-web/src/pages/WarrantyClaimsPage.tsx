import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  DataTable,
  ErrorBanner,
  Input,
  Select,
  Spinner,
} from '@retail/ui-kit';
import { warrantyApi } from '../api/warranty';
import { describeError } from '../lib/apiClient';
import { formatDate, formatDateTime } from '../lib/datetime';
import { claimTone, isResolvable, warrantyTone } from '../lib/claims';
import { usePermission } from '../hooks/usePermission';
import type { ClaimResolution, WarrantyClaim, WarrantyListRow } from '../lib/apiTypes';

/**
 * Phase 13 (ERP slice) — RESOLVING A WARRANTY CLAIM.
 *
 * THIS IS THE HALF THE POS DELIBERATELY EXCLUDED. A till can register
 * cover and lodge a claim while the customer is standing there; deciding
 * to repair, replace or reject happens after inspection, days later, and
 * belongs to the back office. Both surfaces call the same
 * `warranty.claim`-gated endpoint — the split is about where the screen
 * lives, never a second contract.
 *
 * THE FRONTEND DECIDES NOTHING. It does not judge eligibility, compute a
 * coverage date, or invent a status: `effectiveStatus` is derived by the
 * server on read, and the only two outcomes that exist are RESOLVED and
 * REJECTED because `resolveWarrantyClaimSchema` accepts exactly those. A
 * claim that is not OPEN is refused with a 409, and so is a second
 * concurrent resolution — this screen offers the control, the server
 * decides the outcome, and the authoritative result is what gets rendered.
 *
 * `warranty.claim` gates the control; `warranty.view` gates the screen. An
 * ACCOUNTANT holds the latter and not the former, so they read claim
 * history and see no resolve button — which is the live permission model,
 * not a rule invented here.
 */
export function WarrantyClaimsPage() {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Warranties that have been claimed against. `status=CLAIMED` is the
  // backend's own filter; there is no "list all open claims" endpoint, and
  // inventing one was not needed to reach the work.
  const list = useQuery({
    queryKey: ['warranties', 'CLAIMED'],
    queryFn: () => warrantyApi.list({ status: 'CLAIMED' }),
  });

  return (
    <div className="mx-auto max-w-6xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('claims.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('claims.explainer')}</p>

      {list.isError && <ErrorBanner {...describeError(list.error)} />}

      <DataTable
        data-testid="warranty-table"
        loading={list.isLoading}
        rows={list.data?.data ?? []}
        rowKey={(w) => w.id}
        empty={t('claims.noneClaimed')}
        onRowClick={(w) => setSelectedId(w.id)}
        isRowActive={(w) => w.id === selectedId}
        columns={[
          { key: 'serial', header: t('claims.serial'), className: 'numeric', cell: (w: WarrantyListRow) => w.serialNumber.serial },
          { key: 'sale', header: t('claims.sale'), className: 'numeric', cell: (w) => w.saleItem.sale.saleNumber },
          { key: 'customer', header: t('claims.customer'), cell: (w) => w.customer?.name ?? t('claims.walkIn') },
          {
            key: 'status',
            header: t('claims.warrantyStatus'),
            cell: (w) => <Badge tone={warrantyTone(w.effectiveStatus)}>{t(`claims.warranty.${w.effectiveStatus}`)}</Badge>,
          },
          { key: 'claims', header: t('claims.claimCount'), align: 'end', className: 'numeric', cell: (w) => String(w.claimCount) },
          { key: 'ends', header: t('claims.coverEnds'), align: 'end', cell: (w) => formatDate(w.endDate) },
        ]}
      />

      {selectedId && <WarrantyDetailPanel warrantyId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

// ====================================================================
function WarrantyDetailPanel({ warrantyId, onClose }: { warrantyId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canResolve = usePermission('warranty.claim');

  const [resolving, setResolving] = useState<WarrantyClaim | null>(null);
  const [outcome, setOutcome] = useState<ClaimResolution>('RESOLVED');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [lastResult, setLastResult] = useState<WarrantyClaim | null>(null);

  const detail = useQuery({
    queryKey: ['warranty', warrantyId],
    queryFn: () => warrantyApi.get(warrantyId),
  });

  async function handleResolve() {
    if (!resolving) return;
    setPending(true);
    setError(null);
    try {
      const { data } = await warrantyApi.resolveClaim(warrantyId, resolving.id, {
        status: outcome,
        resolution: note.trim() || undefined,
      });
      // THE AUTHORITATIVE RESULT, rendered as the server returned it -
      // its status, its resolvedAt, its resolution text. Nothing is
      // assumed from what was submitted.
      setLastResult(data);
      setResolving(null);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['warranty', warrantyId] });
      await queryClient.invalidateQueries({ queryKey: ['warranties', 'CLAIMED'] });
    } catch (err) {
      // Already resolved, or resolved concurrently by someone else. The
      // server's own words are the whole recovery.
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  if (detail.isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="mt-4">
        <ErrorBanner {...describeError(detail.error)} />
      </div>
    );
  }

  const warranty = detail.data!.data;

  return (
    <Card className="mt-4">
      <CardBody className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="numeric text-sm font-bold text-neutral-900">{warranty.serialNumber.serial}</p>
            <p className="text-xs text-neutral-500">
              {t('claims.sale')}: <span className="numeric">{warranty.saleItem.sale.saleNumber}</span>
            </p>
            <p className="text-xs text-neutral-500">
              {t('claims.cover')}: {formatDate(warranty.startDate)} –{' '}
              {formatDate(warranty.endDate)} ({t('claims.days', { days: warranty.durationDays })})
            </p>
            <p className="text-xs text-neutral-500">
              {t('claims.customer')}: {warranty.customer?.name ?? t('claims.walkIn')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={warrantyTone(warranty.effectiveStatus)}>{t(`claims.warranty.${warranty.effectiveStatus}`)}</Badge>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </div>

        {error && <ErrorBanner title={error.title} message={error.message} />}

        {lastResult && (
          <div className="rounded-lg border border-success-200 bg-success-50 p-3" data-testid="resolution-result">
            <p className="text-sm font-semibold text-success-700">
              {t('claims.resolvedAs', { status: t(`claims.status.${lastResult.status}`) })}
            </p>
            <p className="mt-0.5 text-xs text-neutral-600">
              {formatDateTime(lastResult.resolvedAt)}
              {lastResult.resolution ? ` · ${lastResult.resolution}` : ''}
            </p>
          </div>
        )}

        <h2 className="text-sm font-bold text-neutral-900">{t('claims.history')}</h2>
        <ul className="flex flex-col gap-2">
          {warranty.claims.map((claim) => (
            <li key={claim.id} className="rounded-lg border border-neutral-200 p-3" data-testid={`claim-${claim.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-neutral-800">{claim.description}</p>
                  <p className="text-xs text-neutral-400">{formatDateTime(claim.claimedAt)}</p>
                  {claim.resolution && <p className="mt-0.5 text-xs text-neutral-600">{claim.resolution}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={claimTone(claim.status)}>{t(`claims.status.${claim.status}`)}</Badge>
                  {/* Offered only for an OPEN claim (the server refuses any
                      other), and only to a holder of `warranty.claim`. */}
                  {canResolve && isResolvable(claim) && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setResolving(claim);
                        setOutcome('RESOLVED');
                        setError(null);
                      }}
                      data-testid={`resolve-${claim.id}`}
                    >
                      {t('claims.resolveAction')}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
          {warranty.claims.length === 0 && <li className="text-sm text-neutral-500">{t('claims.noClaims')}</li>}
        </ul>
      </CardBody>

      <ConfirmDialog
        open={Boolean(resolving)}
        title={t('claims.resolveTitle')}
        message={t('claims.resolveWarning')}
        confirmLabel={t('claims.resolveSubmit')}
        cancelLabel={t('common.cancel')}
        pending={pending}
        onConfirm={() => void handleResolve()}
        onClose={() => setResolving(null)}
        data-testid="resolve-dialog"
      >
        <Select
          label={t('claims.outcome')}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as ClaimResolution)}
          data-testid="resolve-outcome"
        >
          {/* Exactly the two the backend accepts. */}
          <option value="RESOLVED">{t('claims.status.RESOLVED')}</option>
          <option value="REJECTED">{t('claims.status.REJECTED')}</option>
        </Select>
        <Input
          label={t('claims.resolutionNote')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          data-testid="resolve-note"
        />
      </ConfirmDialog>
    </Card>
  );
}
