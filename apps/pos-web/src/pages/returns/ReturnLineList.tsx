import { useTranslation } from 'react-i18next';
import { Badge, Card, CardBody, Input, Select } from '@retail/ui-kit';
import type { ReturnLineDraft } from '../../lib/returnLines';

/**
 * Phase 12 (Returns / Exchange) — the "which goods are coming back" form.
 *
 * Extracted, not duplicated: this is the exact block `ReturnsPage`'s
 * stand-alone return builder always rendered, now shared with the exchange
 * builder's return half — the same sale, the same eligible lines, the same
 * serial-selection rules, whichever door the cashier is using.
 */
export function ReturnLineList({
  lines,
  onUpdate,
  onChooseSerials,
}: {
  lines: ReturnLineDraft[];
  onUpdate: (saleItemId: string, patch: Partial<ReturnLineDraft>) => void;
  onChooseSerials: (saleItemId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      {lines.map((line) => (
        <Card key={line.saleItemId}>
          <CardBody className="flex flex-col gap-2 p-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={line.selected}
                disabled={line.availableToReturn <= 0}
                onChange={(e) => onUpdate(line.saleItemId, { selected: e.target.checked })}
                data-testid={`return-line-${line.sku}`}
              />
              <span className="flex-1">
                <span className="block text-sm font-semibold text-neutral-900">{line.name}</span>
                {line.alternativeName && <span className="block text-xs text-neutral-500">{line.alternativeName}</span>}
                <span className="numeric block text-xs text-neutral-500">{line.sku}</span>
                <span className="mt-1 flex flex-wrap gap-2 text-[11px] text-neutral-500">
                  <span>
                    {t('returns.soldQuantity')}: <span className="numeric">{line.quantitySold}</span>
                  </span>
                  {line.quantityAlreadyReturned > 0 && (
                    <span>
                      {t('returns.alreadyReturned')}: <span className="numeric">{line.quantityAlreadyReturned}</span>
                    </span>
                  )}
                  <span>
                    {t('returns.availableToReturn')}: <span className="numeric">{line.availableToReturn}</span>
                  </span>
                </span>
              </span>
              {line.availableToReturn <= 0 && <Badge tone="neutral">{t('returns.fullyReturned')}</Badge>}
            </label>

            {line.selected && (
              <div className="flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-2">
                <Input
                  label={t('returns.quantityToReturn')}
                  type="number"
                  className="numeric w-24"
                  min={1}
                  max={line.availableToReturn}
                  value={line.quantity}
                  onChange={(e) => onUpdate(line.saleItemId, { quantity: Number(e.target.value), serials: [] })}
                />
                <Select
                  label={t('returns.condition')}
                  value={line.condition}
                  onChange={(e) => onUpdate(line.saleItemId, { condition: e.target.value as 'SELLABLE' | 'DAMAGED' })}
                >
                  <option value="SELLABLE">{t('returns.sellable')}</option>
                  <option value="DAMAGED">{t('returns.damaged')}</option>
                </Select>
                {line.requiresSerials && (
                  <button
                    type="button"
                    onClick={() => onChooseSerials(line.saleItemId)}
                    className={`mb-1 rounded-lg border px-3 py-2 text-xs font-medium ${
                      line.serials.length === line.quantity
                        ? 'border-success-600 text-success-700'
                        : 'border-warning-600 text-warning-700'
                    }`}
                    data-testid={`choose-serials-${line.sku}`}
                  >
                    {line.serials.length === line.quantity
                      ? `${t('returns.chooseSerials')}: ${line.serials.join(', ')}`
                      : t('returns.serialsNeeded', { needed: line.quantity })}
                  </button>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
