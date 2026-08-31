import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, EmptyState, ErrorBanner, Spinner } from '@retail/ui-kit';
import { shiftsApi } from '../api/shifts';
import { cashRegistersApi } from '../api/cashRegisters';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { hasExpectedCashVisibility, movementLabelKey, movesCashOut, shiftUiState, signedAmount } from '../lib/shiftCash';
import { usePermission } from '../hooks/usePermission';
import { useShiftStore } from '../store/shiftStore';
import { CashMovementModal } from './shift/CashMovementModal';
import type { CashTransaction } from '../lib/apiTypes';

/**
 * Phase 12 (Cash Drawer) — the state of the till, without giving the game
 * away.
 *
 * WHAT THIS SCREEN MAY SHOW AND WHY. The opening float (the cashier keyed it
 * in), the register and warehouse, when the shift opened, and the movement
 * ledger as an audit trail. What it must NOT show — to the person who will
 * later count the drawer — is what the documents say the drawer should hold.
 *
 * THE EXPECTED FIGURE IS NOT HIDDEN HERE; IT IS ABSENT. The server strips
 * `expectedCash`, `variance`, `cashIn` and `cashOut` from every shift
 * response for a caller without `shifts.view_expected`, so a cashier's
 * device never receives them. This screen renders them only when the server
 * actually sent them, which is the same thing as saying only when the
 * viewer is entitled to them. There is no client-side branch that could be
 * flipped to reveal a number that was never delivered.
 *
 * AND NOTHING HERE ADDS THE MOVEMENTS UP. `openingFloat + SUM(movements)` IS
 * the expected figure; a running total on this page would hand the counting
 * cashier the exact answer blind close exists to withhold. The rows are
 * listed individually, as history, and `lib/shiftCash.ts` deliberately
 * provides no function that would total them.
 */
export function ShiftPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setActiveShift = useShiftStore((s) => s.setActiveShift);
  const canCloseShift = usePermission('shifts.close');
  const canMoveCash = usePermission('cash.movement');

  const [movementOpen, setMovementOpen] = useState(false);

  // The SOURCE OF TRUTH, re-read here rather than trusted from the store:
  // the persisted copy is a cache, and a shift closed on another device is
  // exactly the case this screen must not get wrong.
  const shiftQuery = useQuery({
    queryKey: ['active-shift'],
    queryFn: () => shiftsApi.active(),
  });
  const shift = shiftQuery.data?.data ?? null;
  const state = shiftUiState(shift);

  const registersQuery = useQuery({
    queryKey: ['cash-registers', shift?.branchId],
    queryFn: () => cashRegistersApi.list(shift!.branchId),
    enabled: Boolean(shift),
  });
  const register = registersQuery.data?.data.find((r) => r.id === shift?.cashRegisterId) ?? null;

  const movementsQuery = useQuery({
    queryKey: ['cash-movements', shift?.id],
    queryFn: () => shiftsApi.cashTransactions(shift!.id),
    enabled: Boolean(shift),
  });

  if (shiftQuery.isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }

  if (state === 'NONE') {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <Badge tone="neutral">{t('cashDrawer.state.NONE')}</Badge>
        <p className="mt-3 text-sm text-neutral-600">{t('cashDrawer.noShiftExplainer')}</p>
        <Button
          className="mt-4"
          onClick={() => {
            setActiveShift(null);
            navigate('/shift-setup');
          }}
        >
          {t('cashDrawer.openShiftAction')}
        </Button>
      </div>
    );
  }

  const showsExpected = hasExpectedCashVisibility(shift);

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-neutral-900">{t('cashDrawer.title')}</h1>
        <Badge tone={state === 'OPEN' ? 'success' : state === 'AWAITING_RECONCILIATION' ? 'warning' : 'neutral'}>
          {t(`cashDrawer.state.${state}`)}
        </Badge>
      </div>

      <Card>
        <CardBody className="flex flex-col gap-1.5 p-4">
          <Row label={t('cashDrawer.register')} value={register ? `${register.name} (${register.code})` : '—'} />
          <Row label={t('cashDrawer.openedAt')} value={new Date(shift!.openedAt).toLocaleString()} />
          <Row label={t('shiftSetup.openingFloat')} value={formatMoney(shift!.openingFloat)} numeric />
          {shift!.closedAt && <Row label={t('shiftClose.closedAt')} value={new Date(shift!.closedAt).toLocaleString()} />}
          {shift!.countedCash !== null && (
            <Row label={t('shiftClose.countedCashLabel')} value={formatMoney(shift!.countedCash)} numeric />
          )}

          {/* Rendered ONLY because the server sent them, i.e. only for a
              caller holding `shifts.view_expected`. A cashier's response
              carries no such fields at all. */}
          {showsExpected && (
            <>
              <div className="my-1 border-t border-neutral-200" />
              <Row label={t('cashDrawer.cashIn')} value={formatMoney(shift!.cashIn)} numeric />
              <Row label={t('cashDrawer.cashOut')} value={formatMoney(shift!.cashOut)} numeric />
              <Row label={t('cashDrawer.expectedCash')} value={formatMoney(shift!.expectedCash)} numeric />
            </>
          )}
        </CardBody>
      </Card>

      {/* The cashier is told plainly that they will be counting blind, so
          the close screen is not a surprise. */}
      {!showsExpected && state === 'OPEN' && (
        <p className="mt-2 text-xs leading-snug text-neutral-500">{t('cashDrawer.blindHint')}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {state === 'OPEN' && canMoveCash && (
          <Button variant="secondary" size="sm" onClick={() => setMovementOpen(true)} data-testid="record-movement">
            {t('cashDrawer.movementTitle')}
          </Button>
        )}
        {state === 'OPEN' && canCloseShift && (
          <Button size="sm" onClick={() => navigate('/shift-close')} data-testid="go-close-shift">
            {t('nav.closeShift')}
          </Button>
        )}
      </div>

      {state === 'AWAITING_RECONCILIATION' && (
        <p className="mt-3 text-xs leading-snug text-warning-700">{t('cashDrawer.awaitingReconciliation')}</p>
      )}

      <h2 className="mb-2 mt-5 text-sm font-bold text-neutral-900">{t('cashDrawer.movements')}</h2>
      <p className="mb-2 text-xs leading-snug text-neutral-500">{t('cashDrawer.movementsNotice')}</p>

      {movementsQuery.isLoading && <Spinner />}
      {movementsQuery.isError && <ErrorBanner {...describeError(movementsQuery.error)} />}
      {movementsQuery.data && movementsQuery.data.data.length === 0 && <EmptyState title={t('cashDrawer.noMovements')} />}

      <ul className="flex flex-col gap-1.5">
        {movementsQuery.data?.data.map((m) => (
          <li key={m.id}>
            <MovementRow movement={m} />
          </li>
        ))}
      </ul>

      {shift && (
        <CashMovementModal
          open={movementOpen}
          shiftId={shift.id}
          onClose={() => setMovementOpen(false)}
          onRecorded={() => {
            void movementsQuery.refetch();
            void shiftQuery.refetch();
          }}
        />
      )}
    </div>
  );
}

// ====================================================================
/** One row of the drawer's history. The figure shown is this movement's
 * OWN signed amount, straight from the server — nothing accumulates. */
function MovementRow({ movement }: { movement: CashTransaction }) {
  const { t } = useTranslation();
  const out = movesCashOut(movement);
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white p-2.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={out ? 'danger' : 'success'}>{t(movementLabelKey(movement.type))}</Badge>
          <span className="text-xs text-neutral-500">{new Date(movement.createdAt).toLocaleTimeString()}</span>
        </div>
        {movement.reason && <p className="mt-0.5 truncate text-xs text-neutral-600">{movement.reason}</p>}
      </div>
      <span className={`numeric shrink-0 text-sm font-bold ${out ? 'text-danger-700' : 'text-success-700'}`}>
        {formatMoney(signedAmount(movement))}
      </span>
    </div>
  );
}

function Row({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-neutral-500">{label}</span>
      <span className={`font-semibold text-neutral-800 ${numeric ? 'numeric' : ''}`}>{value}</span>
    </div>
  );
}
