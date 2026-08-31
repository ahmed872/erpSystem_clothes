import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, CardBody, ErrorBanner, Input } from '@retail/ui-kit';
import { shiftsApi } from '../api/shifts';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { hasExpectedCashVisibility, varianceKind } from '../lib/shiftCash';
import { useShiftStore } from '../store/shiftStore';
import { useAuthStore } from '../store/authStore';
import { authApi } from '../api/auth';
import type { Shift } from '../lib/apiTypes';

/**
 * Phase 12 (Cash Drawer) — BLIND CLOSE (BD-17 rules 4–7).
 *
 * THE REQUEST CARRIES THE COUNTED AMOUNT AND NOTHING ELSE that bears on the
 * cash. There is no expected figure on this screen to compare against, no
 * "suggested" amount pre-filled, and no target to nudge the count toward:
 * the field starts EMPTY rather than at zero, so a cashier who submits has
 * necessarily typed what they counted.
 *
 * THE FIGURE IS NOT MERELY HIDDEN — IT WAS NEVER SENT. The server removes
 * `expectedCash`, `variance`, `cashIn` and `cashOut` from the shift
 * endpoints AND from this close response for anyone without
 * `shifts.view_expected`. So the result block below is not a permission
 * check the client performs; it renders what arrived. A cashier's device
 * holds no copy of the number in state, in a response, or in an error.
 *
 * WHAT CHANGED IN THIS MILESTONE. The result block previously carried
 * hard-coded English labels ("Expected", "Variance") in an Arabic-first
 * product, showed a bare signed number where a cashier needs to read
 * OVERAGE or SHORTAGE, and said nothing about whether a manager still has
 * to sign the shift off. The counted amount also defaulted to "0", which a
 * hurried cashier could submit without counting at all.
 */
export function ShiftClosePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeShift = useShiftStore((s) => s.activeShift);
  const setActiveShift = useShiftStore((s) => s.setActiveShift);
  const clearAuth = useAuthStore((s) => s.clear);
  const refreshToken = useAuthStore((s) => s.refreshToken);

  const [countedCash, setCountedCash] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [closed, setClosed] = useState<Shift | null>(null);

  // ORDER MATTERS. A successful close clears the cached active shift (so
  // the rest of the app stops believing a till is open), which would make
  // an `activeShift` guard placed first blank the very result the cashier
  // just earned. The close result is owned by this component, not by the
  // store, so it is checked first.
  if (closed) return <CloseResult closed={closed} onDone={handleDone} />;
  if (!activeShift) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // ONLY the counted amount (and the cashier's own note). The server
      // derives expected cash, the variance, and the journal entry that
      // posts it.
      const { data } = await shiftsApi.close({ countedCash: Number(countedCash) || 0, notes: notes || undefined });
      setClosed(data);
      // The cached shift is deliberately NOT cleared here. `RequireShift`
      // redirects to /shift-setup the moment it sees no active shift, which
      // would evict this route before the cashier ever saw the result of
      // the close they just submitted. It is cleared in `handleDone`, once
      // they have read it. Nothing is riding on the stale copy in between:
      // the server refuses a second close with a 409, so the guarantee
      // lives where it belongs rather than in this component's state.
    } catch (err) {
      // A shift already closed on another device returns 409. Surfacing
      // the server's message is the whole recovery — there is no
      // client-side lock to reconcile.
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDone() {
    setActiveShift(null);
    try {
      if (refreshToken) await authApi.logout(refreshToken);
    } catch {
      /* best-effort */
    }
    clearAuth();
    navigate('/login', { replace: true });
  }

  const counted = Number(countedCash);
  const canSubmit = countedCash.trim().length > 0 && Number.isFinite(counted) && counted >= 0 && !submitting;

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <Card className="w-full max-w-sm">
        <CardBody className="flex flex-col gap-4 p-6">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-bold text-neutral-900">{t('shiftClose.title')}</h1>
            <Badge tone="warning">{t('cashDrawer.state.CLOSING')}</Badge>
          </div>

          {/* The instruction, given prominence rather than as fine print:
              this is the one moment the cashier is asked to do something
              physical, and doing it carelessly is what a blind close is
              designed to detect. */}
          <div className="rounded-lg border border-warning-200 bg-warning-50 p-3">
            <p className="text-sm font-semibold text-neutral-800">{t('shiftClose.countInstruction')}</p>
            <p className="mt-1 text-xs leading-snug text-neutral-600">{t('shiftClose.blindNotice')}</p>
          </div>

          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Input
              label={t('shiftClose.countedCash')}
              hint={t('shiftClose.countedCashHint')}
              type="number"
              min={0}
              step={0.01}
              className="numeric"
              placeholder="0.00"
              value={countedCash}
              onChange={(e) => setCountedCash(e.target.value)}
              autoFocus
              data-testid="counted-cash"
            />
            <Input label={t('shiftClose.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="close-notes" />
            {error && <ErrorBanner title={error.title} message={error.message} />}
            <Button type="submit" fullWidth loading={submitting} disabled={!canSubmit} data-testid="submit-close">
              {t('shiftClose.submit')}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

// ====================================================================
/**
 * The result, AFTER submission — and only as much of it as the server sent.
 *
 * `varianceKind` classifies the SIGN of the server's own figure so a cashier
 * reads "over by 5" rather than "-5"; it computes no variance. When the
 * caller was not sent one (the blind-close cashier), it returns null and
 * this block simply does not appear.
 */
function CloseResult({ closed, onDone }: { closed: Shift; onDone: () => void }) {
  const { t } = useTranslation();
  const showsExpected = hasExpectedCashVisibility(closed);
  const kind = varianceKind(closed.variance);

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <Card className="w-full max-w-sm">
        <CardBody className="flex flex-col gap-3 p-6">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-bold text-neutral-900">{t('shiftClose.summaryTitle')}</h1>
            <Badge tone="success">{t('cashDrawer.state.CLOSED')}</Badge>
          </div>

          <SummaryRow label={t('shiftClose.openedAt')} value={new Date(closed.openedAt).toLocaleString()} />
          <SummaryRow label={t('shiftClose.closedAt')} value={closed.closedAt ? new Date(closed.closedAt).toLocaleString() : '—'} />
          <SummaryRow label={t('shiftSetup.openingFloat')} value={formatMoney(closed.openingFloat)} />
          <SummaryRow label={t('shiftClose.countedCashLabel')} value={formatMoney(closed.countedCash)} testId="result-counted" />

          {showsExpected ? (
            <>
              <div className="border-t border-neutral-200 pt-2" />
              <SummaryRow label={t('cashDrawer.expectedCash')} value={formatMoney(closed.expectedCash)} testId="result-expected" />
              {kind && (
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-neutral-500">{t('cashDrawer.variance')}</span>
                  <span
                    className={`numeric font-bold ${
                      kind === 'SHORTAGE' ? 'text-danger-700' : kind === 'OVERAGE' ? 'text-warning-700' : 'text-success-700'
                    }`}
                    data-testid="result-variance"
                  >
                    {formatMoney(closed.variance)} · {t(`cashDrawer.varianceKind.${kind}`)}
                  </span>
                </div>
              )}
            </>
          ) : (
            // Rule 4 is "not before submission", but the figure stays behind
            // `shifts.view_expected` even afterwards: a cashier who learns
            // the expected amount after every close learns it for every
            // future one, which hollows out blind counting over time.
            <p className="text-xs leading-snug text-neutral-500" data-testid="expected-withheld">
              {t('shiftClose.expectedWithheld')}
            </p>
          )}

          <p className="text-xs leading-snug text-neutral-500">
            {closed.reconciledAt ? t('cashDrawer.reconciled') : t('cashDrawer.awaitingReconciliation')}
          </p>

          <Button className="mt-2" onClick={onDone} data-testid="close-done">
            {t('shiftClose.done')}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

function SummaryRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-neutral-500">{label}</span>
      <span className="numeric font-semibold text-neutral-800" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
