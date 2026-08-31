import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal } from '@retail/ui-kit';

/** Minimal shape this modal needs — deliberately NOT `CartLine`, so it can
 * capture serials for a replacement line in an exchange (which has no cart
 * entry at all) exactly as it does for a POS cart line. */
export interface SerialCaptureTarget {
  productName: string;
  quantity: number;
  serials: string[];
}

export function SerialCaptureModal({
  line,
  onClose,
  onSave,
}: {
  line: SerialCaptureTarget | null;
  onClose: () => void;
  onSave: (serials: string[]) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<string[]>([]);

  useEffect(() => {
    if (line) {
      const initial = [...line.serials];
      while (initial.length < line.quantity) initial.push('');
      setValues(initial.slice(0, line.quantity));
    }
  }, [line]);

  if (!line) return null;

  const allFilled = values.every((v) => v.trim().length > 0) && values.length === line.quantity;
  const hasDuplicates = new Set(values.map((v) => v.trim())).size !== values.length;

  return (
    <Modal
      open={Boolean(line)}
      onClose={onClose}
      title={`${t('checkout.serialsTitle')} — ${line.productName}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!allFilled || hasDuplicates} onClick={() => onSave(values.map((v) => v.trim()))}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {values.map((value, i) => (
          <Input
            key={i}
            label={`${t('checkout.serialsTitle')} ${i + 1}`}
            value={value}
            onChange={(e) => setValues((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
            autoFocus={i === 0}
          />
        ))}
        {hasDuplicates && <p className="text-xs text-danger-600">{t('checkout.serialsMustBeUnique')}</p>}
      </div>
    </Modal>
  );
}
