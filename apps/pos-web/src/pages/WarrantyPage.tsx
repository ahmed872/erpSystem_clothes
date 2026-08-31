import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, EmptyState, ErrorBanner, Input, Modal, Spinner, SpinnerOverlay } from '@retail/ui-kit';
import { salesApi } from '../api/sales';
import { warrantyApi } from '../api/warranty';
import { describeError } from '../lib/apiClient';
import { canRaiseClaim, statusTone, unitWarrantyState, unitsFromReceipt, warrantyForUnit, type WarrantyUnit } from '../lib/warrantyUnits';
import { usePermission } from '../hooks/usePermission';

/**
 * Phase 12 (Warranty) — registering and looking up cover, at the till.
 *
 * THE BOUNDARY, ESTABLISHED FROM THE PERMISSION MATRIX RATHER THAN FROM
 * CONVENIENCE. A CASHIER holds `warranty.view`, `warranty.register` AND
 * `warranty.claim`; a SALES_EMPLOYEE holds view + register but not claim.
 * So registration and lodging a claim are POS acts, and this screen offers
 * both, each behind its own permission. CLAIM RESOLUTION is deliberately
 * NOT here: deciding to repair, replace or reject happens after inspection,
 * not at a till with a customer waiting, and it belongs to the back office.
 * That boundary is documented rather than assumed — the permission would
 * allow it.
 *
 * NOTHING ABOUT VALIDITY IS DECIDED HERE. Coverage dates are snapshotted at
 * registration; `effectiveStatus` is derived by the server on read. This
 * screen displays the server's answer and never compares a date. It also
 * sends no dates and no duration when registering: `startDate` is the
 * SALE's own timestamp and the length comes from the business default, so
 * a till cannot invent a warranty period.
 *
 * AND THE CASHIER CANNOT NAME AN ARBITRARY SERIAL. The units offered are
 * exactly `receipt.items[].serialUnits` — what the sale actually delivered,
 * on the line that delivered it. The server then re-verifies the same fact
 * through `SaleItemSerial` (the rule that closed Known Issue #47), so the
 * list here is a convenience, never the check.
 */
type Stage = { kind: 'find' } | { kind: 'sale'; saleId: string };

export function WarrantyPage() {
  const [stage, setStage] = useState<Stage>({ kind: 'find' });

  if (stage.kind === 'sale') {
    return <SaleWarranties saleId={stage.saleId} onBack={() => setStage({ kind: 'find' })} />;
  }
  return <FindSale onPick={(saleId) => setStage({ kind: 'sale', saleId })} />;
}

// ====================================================================
// 1 — FIND THE SALE (same lookup the Returns screen uses)
// ====================================================================
function FindSale({ onPick }: { onPick: (saleId: string) => void }) {
  const { t } = useTranslation();
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    const raw = term.trim();
    if (!raw) return;
    setSearching(true);
    setNotFound(false);
    setError(null);
    try {
      const { data } = await salesApi.findByNumber(raw);
      if (data.length === 0) setNotFound(true);
      else onPick(data[0].id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('warranty.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('warranty.explainer')}</p>

      <Card>
        <CardBody className="p-3">
          <form onSubmit={handleSearch} className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-neutral-700">{t('returns.findSale')}</p>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label={t('returns.saleNumberLabel')}
                  hint={t('returns.saleNumberHint')}
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  className="numeric"
                  autoFocus
                  data-testid="warranty-sale-number"
                />
              </div>
              <Button type="submit" loading={searching} disabled={searching || term.trim().length === 0} data-testid="warranty-sale-search">
                {t('returns.searchAction')}
              </Button>
            </div>
          </form>
          {notFound && (
            <p className="mt-2 text-sm font-medium text-danger-600" data-testid="warranty-sale-not-found">
              {t('returns.notFound')}
            </p>
          )}
          {error && (
            <div className="mt-2">
              <ErrorBanner title={error.title} message={error.message} />
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// ====================================================================
// 2 — THE UNITS THIS SALE DELIVERED
// ====================================================================
function SaleWarranties({ saleId, onBack }: { saleId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const receiptQuery = useQuery({ queryKey: ['sale-receipt', saleId], queryFn: () => salesApi.receipt(saleId) });

  if (receiptQuery.isLoading) return <SpinnerOverlay />;
  if (receiptQuery.isError) {
    return (
      <div className="p-4">
        <ErrorBanner {...describeError(receiptQuery.error)} />
      </div>
    );
  }

  const receipt = receiptQuery.data!.data;
  const units = unitsFromReceipt(receipt);

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <button type="button" onClick={onBack} className="mb-3 text-sm text-brand-700">
        ← {t('common.back')}
      </button>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="numeric text-lg font-bold text-neutral-900">{receipt.sale.saleNumber}</h1>
        {/* THE CUSTOMER CONTEXT IS THE SALE'S OWN. A warranty's customer is
            denormalised from the sale at registration and is never chosen
            here, so a walk-in sale produces a warranty with no customer —
            which the backend permits and this screen states plainly rather
            than demanding one. */}
        <Badge tone={receipt.customer ? 'brand' : 'neutral'} data-testid="warranty-customer">
          {receipt.customer ? receipt.customer.name : t('returns.walkInSale')}
        </Badge>
        <span className="text-xs text-neutral-500">
          {t('returns.soldOn')}: {new Date(receipt.sale.createdAt).toLocaleString()}
        </span>
      </div>

      {units.length === 0 ? (
        <EmptyState title={t('warranty.noSerialItems')} description={t('warranty.noSerialItemsHint')} />
      ) : (
        <>
          <p className="mb-2 text-sm font-semibold text-neutral-700">{t('warranty.unitsHeading')}</p>
          <ul className="flex flex-col gap-2">
            {units.map((unit) => (
              <li key={`${unit.saleItemId}:${unit.serialNumberId}`}>
                <UnitCard unit={unit} customerName={receipt.customer?.name ?? null} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ====================================================================
// 3 — ONE PHYSICAL UNIT
// ====================================================================
function UnitCard({ unit, customerName }: { unit: WarrantyUnit; customerName: string | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canRegister = usePermission('warranty.register');
  const canClaim = usePermission('warranty.claim');

  const [registering, setRegistering] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  // The server's answer about this unit. Asked per unit because
  // `warrantyListQuerySchema` filters by one serial at a time; a receipt
  // carries few serial units, and the queries run in parallel and cache.
  const query = useQuery({
    queryKey: ['warranty-for-serial', unit.serialNumberId],
    queryFn: () => warrantyApi.forSerial(unit.serialNumberId),
  });

  const warranty = query.data ? warrantyForUnit(unit, query.data.data) : null;
  const state = unitWarrantyState(warranty);

  async function handleRegister() {
    setRegistering(true);
    setError(null);
    try {
      // NO DATES AND NO DURATION. The sale's own timestamp starts the
      // cover; the business default sets its length. If none is configured
      // the server refuses with a clear message, which is the honest
      // outcome — a till must not guess a warranty period.
      await warrantyApi.register({ saleItemId: unit.saleItemId, serialNumberId: unit.serialNumberId });
      await queryClient.invalidateQueries({ queryKey: ['warranty-for-serial', unit.serialNumberId] });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRegistering(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-neutral-900">{unit.productName}</p>
            {unit.alternativeName && <p className="text-xs text-neutral-500">{unit.alternativeName}</p>}
            <p className="numeric text-xs text-neutral-500">{unit.sku}</p>
            <p className="mt-1 text-xs text-neutral-700">
              {t('warranty.serial')}: <span className="numeric font-semibold">{unit.serial}</span>
            </p>
          </div>
          {query.isLoading ? (
            <Spinner />
          ) : (
            <Badge
              tone={warranty ? statusTone(warranty.effectiveStatus) : 'neutral'}
              data-testid={`warranty-state-${unit.serial}`}
            >
              {warranty ? t(`warranty.status.${warranty.effectiveStatus}`) : t('warranty.status.UNREGISTERED')}
            </Badge>
          )}
        </div>

        {warranty && (
          <div className="rounded-lg bg-neutral-50 p-2.5">
            <Row label={t('warranty.startDate')} value={new Date(warranty.startDate).toLocaleDateString()} />
            <Row label={t('warranty.endDate')} value={new Date(warranty.endDate).toLocaleDateString()} testId={`warranty-end-${unit.serial}`} />
            <Row label={t('warranty.duration')} value={t('warranty.durationDays', { days: warranty.durationDays })} />
            <Row label={t('warranty.customer')} value={warranty.customer?.name ?? customerName ?? t('returns.walkInSale')} />
            {warranty.claimCount > 0 && <Row label={t('warranty.claims')} value={String(warranty.claimCount)} />}
            {state === 'VOIDED' && <p className="mt-1 text-xs leading-snug text-danger-700">{t('warranty.voidedNotice')}</p>}
            {warranty.notes && <p className="mt-1 text-xs leading-snug text-neutral-500">{warranty.notes}</p>}
          </div>
        )}

        {error && <ErrorBanner title={error.title} message={error.message} />}

        <div className="flex flex-wrap gap-2">
          {state === 'UNREGISTERED' && canRegister && (
            <Button
              size="sm"
              loading={registering}
              disabled={registering || query.isLoading}
              onClick={() => void handleRegister()}
              data-testid={`register-warranty-${unit.serial}`}
            >
              {t('warranty.registerAction')}
            </Button>
          )}
          {state === 'REGISTERED' && canClaim && canRaiseClaim(warranty) && (
            <Button size="sm" variant="secondary" onClick={() => setClaimOpen(true)} data-testid={`claim-warranty-${unit.serial}`}>
              {t('warranty.claimAction')}
            </Button>
          )}
        </div>

        {warranty && <ClaimHistory warrantyId={warranty.id} claimCount={warranty.claimCount} />}

        {warranty && (
          <ClaimModal
            open={claimOpen}
            warrantyId={warranty.id}
            serial={unit.serial}
            onClose={() => setClaimOpen(false)}
            onRaised={() => {
              void queryClient.invalidateQueries({ queryKey: ['warranty-for-serial', unit.serialNumberId] });
              void queryClient.invalidateQueries({ queryKey: ['warranty-claims', warranty.id] });
            }}
          />
        )}
      </CardBody>
    </Card>
  );
}

// ====================================================================
/** What the customer has already claimed for. Read-only at the till:
 * resolving a claim is a back-office decision made after inspection. */
function ClaimHistory({ warrantyId, claimCount }: { warrantyId: string; claimCount: number }) {
  const { t } = useTranslation();
  const canView = usePermission('warranty.view');
  const query = useQuery({
    queryKey: ['warranty-claims', warrantyId],
    queryFn: () => warrantyApi.claims(warrantyId),
    enabled: canView && claimCount > 0,
  });

  if (!canView || claimCount === 0) return null;
  if (query.isLoading) return <Spinner />;

  return (
    <ul className="flex flex-col gap-1.5 border-t border-neutral-100 pt-2">
      {query.data?.data.map((claim) => (
        <li key={claim.id} className="flex items-start justify-between gap-2 text-xs">
          <div className="min-w-0">
            <p className="truncate text-neutral-700">{claim.description}</p>
            <p className="text-neutral-400">{new Date(claim.claimedAt).toLocaleString()}</p>
            {claim.resolution && <p className="mt-0.5 text-neutral-500">{claim.resolution}</p>}
          </div>
          <Badge tone={claim.status === 'OPEN' ? 'warning' : claim.status === 'RESOLVED' ? 'success' : 'neutral'}>
            {t(`warranty.claimStatus.${claim.status}`)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

// ====================================================================
function ClaimModal({
  open,
  warrantyId,
  serial,
  onClose,
  onRaised,
}: {
  open: boolean;
  warrantyId: string;
  serial: string;
  onClose: () => void;
  onRaised: () => void;
}) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await warrantyApi.raiseClaim(warrantyId, description.trim());
      onRaised();
      setDescription('');
      onClose();
    } catch (err) {
      // A warranty voided or expired since the page loaded is refused by
      // the server. Showing its own words is the whole recovery.
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('warranty.claimTitle')} size="sm">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-600">{t('warranty.claimExplainer')}</p>
        <p className="text-xs text-neutral-500">
          {t('warranty.serial')}: <span className="numeric font-semibold">{serial}</span>
        </p>
        <Input
          label={t('warranty.claimDescription')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          autoFocus
          data-testid="claim-description"
        />
        {error && <ErrorBanner title={error.title} message={error.message} />}
        <Button
          fullWidth
          loading={saving}
          disabled={saving || description.trim().length === 0}
          onClick={() => void handleSubmit()}
          data-testid="confirm-claim"
        >
          {t('warranty.claimSubmit')}
        </Button>
      </div>
    </Modal>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-neutral-500">{label}</span>
      <span className="font-semibold text-neutral-800" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
