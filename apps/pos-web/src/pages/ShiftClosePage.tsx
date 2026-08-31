import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, ErrorBanner, Input } from '@retail/ui-kit';
import { shiftsApi } from '../api/shifts';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { useShiftStore } from '../store/shiftStore';
import { useAuthStore } from '../store/authStore';
import { authApi } from '../api/auth';
import type { Shift } from '../lib/apiTypes';

export function ShiftClosePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeShift = useShiftStore((s) => s.activeShift);
  const setActiveShift = useShiftStore((s) => s.setActiveShift);
  const clearAuth = useAuthStore((s) => s.clear);
  const refreshToken = useAuthStore((s) => s.refreshToken);

  const [countedCash, setCountedCash] = useState('0');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [closed, setClosed] = useState<Shift | null>(null);

  if (!activeShift) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await shiftsApi.close({ countedCash: Number(countedCash) || 0, notes: notes || undefined });
      setClosed(data);
    } catch (err) {
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

  if (closed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
        <Card className="w-full max-w-sm">
          <CardBody className="flex flex-col gap-3 p-6">
            <h1 className="text-lg font-bold text-neutral-900">{t('shiftClose.summaryTitle')}</h1>
            <SummaryRow label={t('shiftClose.openedAt')} value={new Date(closed.openedAt).toLocaleString()} />
            <SummaryRow label={t('shiftClose.closedAt')} value={closed.closedAt ? new Date(closed.closedAt).toLocaleString() : '—'} />
            <SummaryRow label={t('shiftSetup.openingFloat')} value={formatMoney(closed.openingFloat)} />
            <SummaryRow label={t('shiftClose.countedCashLabel')} value={formatMoney(closed.countedCash)} />
            {closed.expectedCash !== undefined && <SummaryRow label="Expected" value={formatMoney(closed.expectedCash)} />}
            {closed.variance !== undefined && closed.variance !== null && <SummaryRow label="Variance" value={formatMoney(closed.variance)} />}
            <Button className="mt-2" onClick={handleDone}>
              {t('shiftClose.done')}
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <Card className="w-full max-w-sm">
        <CardBody className="flex flex-col gap-4 p-6">
          <h1 className="text-lg font-bold text-neutral-900">{t('shiftClose.title')}</h1>
          <p className="text-xs text-neutral-500">{t('shiftClose.blindNotice')}</p>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Input
              label={t('shiftClose.countedCash')}
              type="number"
              min={0}
              step={0.01}
              className="numeric"
              value={countedCash}
              onChange={(e) => setCountedCash(e.target.value)}
              autoFocus
            />
            <Input label={t('shiftClose.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
            {error && <ErrorBanner title={error.title} message={error.message} />}
            <Button type="submit" fullWidth loading={submitting} disabled={submitting}>
              {t('shiftClose.submit')}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-neutral-500">{label}</span>
      <span className="numeric font-semibold text-neutral-800">{value}</span>
    </div>
  );
}
