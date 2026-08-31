import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ErrorBanner, Input, Modal, Select } from '@retail/ui-kit';
import { shiftsApi } from '../../api/shifts';
import { describeError } from '../../lib/apiClient';

/**
 * Phase 12 (Cash Drawer) — a MANUAL pay-in or pay-out.
 *
 * Only these two types exist here, and that is the backend's rule, not a UI
 * simplification: sale tenders and refunds are written by the sale and
 * return use-cases inside the same transaction as the document that moved
 * the money, so the drawer can never disagree with the paperwork. An
 * endpoint that could hand-write a SALE_TENDER row would break exactly that
 * guarantee, and `createCashMovementSchema` admits only PAY_IN and PAY_OUT.
 *
 * The AMOUNT SENT IS ALWAYS THE POSITIVE MAGNITUDE. The server applies the
 * sign from the type and a database CHECK enforces the agreement, so this
 * screen must not "helpfully" negate a pay-out — doing so would be rejected,
 * and getting it accepted would be worse.
 *
 * A reason is required by the schema, and rightly: an unexplained movement
 * of cash is the thing a drawer audit exists to catch.
 */
export function CashMovementModal({
  open,
  shiftId,
  onClose,
  onRecorded,
}: {
  open: boolean;
  shiftId: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<'PAY_IN' | 'PAY_OUT'>('PAY_OUT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  useEffect(() => {
    if (open) {
      setType('PAY_OUT');
      setAmount('');
      setReason('');
      setError(null);
    }
  }, [open]);

  const magnitude = Number(amount);
  const canSubmit = Number.isFinite(magnitude) && magnitude > 0 && reason.trim().length > 0 && !saving;

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await shiftsApi.recordCashMovement(shiftId, { type, amount: magnitude, reason: reason.trim() });
      onRecorded();
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('cashDrawer.movementTitle')} size="sm">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-600">{t('cashDrawer.movementExplainer')}</p>

        <Select
          label={t('cashDrawer.movementType')}
          value={type}
          onChange={(e) => setType(e.target.value as 'PAY_IN' | 'PAY_OUT')}
          data-testid="movement-type"
        >
          <option value="PAY_OUT">{t('cashDrawer.movement.PAY_OUT')}</option>
          <option value="PAY_IN">{t('cashDrawer.movement.PAY_IN')}</option>
        </Select>

        <Input
          label={t('cashDrawer.movementAmount')}
          hint={t('cashDrawer.movementAmountHint')}
          type="number"
          min={0}
          step={0.01}
          className="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          data-testid="movement-amount"
        />

        <Input
          label={t('cashDrawer.movementReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          data-testid="movement-reason"
        />

        {error && <ErrorBanner title={error.title} message={error.message} />}

        <Button fullWidth loading={saving} disabled={!canSubmit} onClick={() => void handleSubmit()} data-testid="confirm-movement">
          {t('cashDrawer.movementSubmit')}
        </Button>
      </div>
    </Modal>
  );
}
