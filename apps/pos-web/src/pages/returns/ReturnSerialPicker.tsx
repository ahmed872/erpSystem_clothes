import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Modal } from '@retail/ui-kit';

/**
 * Phase 12 (Returns) — WHICH physical units came back.
 *
 * The cashier CHOOSES from the units this sale actually delivered, rather
 * than typing serials into an empty box. The list comes from the receipt
 * payload (`items[].serials`), which is the sale's own record of what left
 * the shop, so a unit that was never sold on this line cannot be picked at
 * all - the mistake the backend used to have to reject.
 *
 * WHAT IS DELIBERATELY NOT SHOWN HERE. Nothing marks which units came back
 * on an EARLIER partial return: no contract exposes that, and inventing a
 * guess would be worse than the truth. Picking one that is already back is
 * refused by the server with `Serial X has already been returned`, which
 * names the unit - so the cashier learns exactly which one to deselect.
 */
export function ReturnSerialPicker({
  open,
  productName,
  soldSerials,
  needed,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  productName: string;
  soldSerials: string[];
  needed: number;
  initial: string[];
  onClose: () => void;
  onSave: (serials: string[]) => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string[]>(initial);

  useEffect(() => {
    if (open) setChosen(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toggle(serial: string) {
    setChosen((prev) => {
      if (prev.includes(serial)) return prev.filter((s) => s !== serial);
      // Never let more than the quantity be selected: the server requires
      // the count to equal it exactly, so the UI simply cannot overshoot.
      if (prev.length >= needed) return prev;
      return [...prev, serial];
    });
  }

  const exact = chosen.length === needed;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${t('returns.chooseSerials')} — ${productName}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!exact} onClick={() => onSave(chosen)} data-testid="serials-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className={`text-xs font-medium ${exact ? 'text-success-700' : 'text-warning-700'}`}>
          {exact ? t('returns.serialsChosen', { count: chosen.length, needed }) : t('returns.serialsNeeded', { needed })}
        </p>
        <ul className="flex flex-col gap-1.5">
          {soldSerials.map((serial) => {
            const selected = chosen.includes(serial);
            const full = !selected && chosen.length >= needed;
            return (
              <li key={serial}>
                <button
                  type="button"
                  disabled={full}
                  onClick={() => toggle(serial)}
                  aria-pressed={selected}
                  className={`flex w-full items-center justify-between rounded-lg border p-2.5 text-start text-sm transition-colors ${
                    selected
                      ? 'border-brand-500 bg-brand-50 font-semibold text-brand-800'
                      : full
                        ? 'cursor-not-allowed border-neutral-200 text-neutral-400'
                        : 'border-neutral-200 hover:border-brand-400'
                  }`}
                >
                  <span className="numeric">{serial}</span>
                  {selected && <Badge tone="brand">✓</Badge>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
