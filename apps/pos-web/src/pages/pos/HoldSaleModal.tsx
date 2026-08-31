import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ErrorBanner, Input, Modal } from '@retail/ui-kit';
import { holdsApi } from '../../api/holds';
import { describeError } from '../../lib/apiClient';
import { holdItemsFromCart } from '../../lib/holdItems';
import { formatMoney, previewLineTotal } from '../../lib/money';
import { useCartStore } from '../../store/cartStore';
import { useShiftStore } from '../../store/shiftStore';

/**
 * Phase 12 (Held Sales) — parking the basket.
 *
 * DELIBERATELY THE SMALLEST DIALOG IN THE APP. Parking a basket exists to
 * get a customer out of the queue, so it asks for one thing the server
 * cannot know — what the cashier will call this basket when they come back
 * for it — and then saves. There is no price to confirm and no payment to
 * take, because nothing is being sold: `POST /sales/holds` writes two rows
 * and moves no money, no stock and no serial.
 *
 * NO TOTAL IS PROMISED HERE. The figure shown is the same client-side
 * estimate the cart screen already carries, labelled as an indication, and
 * it is not stored on the hold. Tax, promotions and loyalty are resolved
 * when the basket is picked up, against the configuration in force THEN —
 * which is why a hold cannot lock in a price or keep an expired promotion
 * alive.
 */
export function HoldSaleModal({ open, onClose, onHeld }: { open: boolean; onClose: () => void; onHeld: () => void }) {
  const { t } = useTranslation();
  const activeShift = useShiftStore((s) => s.activeShift);
  const lines = useCartStore((s) => s.lines);
  const customer = useCartStore((s) => s.customer);
  const clearCart = useCartStore((s) => s.clear);

  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  useEffect(() => {
    if (open) {
      setLabel(customer?.name ?? '');
      setNotes('');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const estimate = lines.reduce((sum, l) => sum + previewLineTotal(l.unitPrice, l.quantity, l.discountAmount), 0);

  async function handleSave() {
    if (!activeShift || lines.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await holdsApi.create({
        warehouseId: activeShift.warehouseId,
        customerId: customer?.id,
        label: label.trim() || undefined,
        notes: notes.trim() || undefined,
        items: holdItemsFromCart(lines),
      });
      // The till is free for the next customer. The basket is safe on the
      // server, and the cashier finds it again under Held sales.
      clearCart();
      onHeld();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('holds.holdTitle')} size="sm">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-600">{t('holds.holdExplainer')}</p>

        <div className="rounded-lg bg-neutral-50 p-3">
          <div className="flex justify-between text-sm text-neutral-600">
            <span>{t('holds.itemCount')}</span>
            <span className="numeric font-semibold">{lines.length}</span>
          </div>
          <div className="flex justify-between text-sm text-neutral-600">
            <span>{t('holds.indicativeValue')}</span>
            <span className="numeric font-semibold" data-testid="hold-indicative">
              {formatMoney(estimate)}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-neutral-400">{t('holds.indicativeNotice')}</p>
        </div>

        <Input
          label={t('holds.labelField')}
          hint={t('holds.labelHint')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={120}
          autoFocus
          data-testid="hold-label"
        />
        <Input label={t('holds.notesField')} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="hold-notes" />

        {error && <ErrorBanner title={error.title} message={error.message} />}

        <Button fullWidth size="lg" loading={saving} disabled={saving || lines.length === 0} onClick={handleSave} data-testid="confirm-hold">
          {saving ? t('holds.holding') : t('holds.holdAction')}
        </Button>
      </div>
    </Modal>
  );
}
