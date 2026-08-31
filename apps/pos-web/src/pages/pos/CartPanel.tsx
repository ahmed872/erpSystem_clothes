import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input } from '@retail/ui-kit';
import { useCartStore } from '../../store/cartStore';
import { usePermission } from '../../hooks/usePermission';
import { loyaltyApi } from '../../api/loyalty';
import { formatMoney, parseMoney, previewLineTotal } from '../../lib/money';
import { CustomerPickerModal } from './CustomerPickerModal';
import { SerialCaptureModal } from './SerialCaptureModal';
import type { CartLine } from '../../store/cartStore';

export function CartPanel({ onCheckout }: { onCheckout: () => void }) {
  const { t } = useTranslation();
  const lines = useCartStore((s) => s.lines);
  const customer = useCartStore((s) => s.customer);
  const redeemPoints = useCartStore((s) => s.redeemPoints);
  const { updateQuantity, updateDiscount, updateUnitPrice, removeLine, setCustomer, setRedeemPoints, setSerials } = useCartStore();
  const canChangePrice = usePermission('products.change_price');
  const canViewLoyalty = usePermission('loyalty.view');

  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [serialLine, setSerialLine] = useState<CartLine | null>(null);

  const pointsQuery = useQuery({
    queryKey: ['loyalty-balance', customer?.id],
    queryFn: () => loyaltyApi.balance(customer!.id),
    enabled: Boolean(customer) && canViewLoyalty,
  });

  const estimateSubtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const estimateDiscount = lines.reduce((sum, l) => sum + l.discountAmount, 0);
  const estimateTotal = Math.max(0, estimateSubtotal - estimateDiscount);
  const missingSerials = lines.some((l) => l.tracksSerialNumbers && l.serials.length !== l.quantity);

  return (
    <div className="flex h-full flex-col border-s border-neutral-200 bg-white">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-bold text-neutral-900">{t('pos.cart')}</h2>
        <button
          type="button"
          onClick={() => setCustomerPickerOpen(true)}
          className="rounded-lg border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
        >
          {customer ? customer.name : t('pos.walkIn')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {lines.length === 0 ? (
          <EmptyState title={t('pos.emptyCart')} />
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.map((line) => (
              <li key={line.key} className="rounded-lg border border-neutral-200 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-neutral-900">{line.productName}</p>
                    {line.variantLabel && <p className="text-xs text-neutral-500">{line.variantLabel}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    className="text-xs font-medium text-danger-600 hover:underline"
                  >
                    {t('pos.remove')}
                  </button>
                </div>

                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <NumberField
                    label={t('pos.quantity')}
                    value={line.quantity}
                    min={1}
                    onChange={(v) => updateQuantity(line.key, v)}
                  />
                  <NumberField
                    label={t('pos.unitPrice')}
                    value={line.unitPrice}
                    min={0}
                    step={0.01}
                    disabled={!canChangePrice}
                    onChange={(v) => updateUnitPrice(line.key, v)}
                  />
                  <NumberField
                    label={t('pos.lineDiscount')}
                    value={line.discountAmount}
                    min={0}
                    step={0.01}
                    onChange={(v) => updateDiscount(line.key, v)}
                  />
                </div>

                {line.tracksSerialNumbers && (
                  <button
                    type="button"
                    onClick={() => setSerialLine(line)}
                    className="mt-2 text-xs font-medium text-brand-700 hover:underline"
                  >
                    {line.serials.length === line.quantity
                      ? `${t('checkout.serialsTitle')}: ${line.serials.join(', ')}`
                      : `⚠ ${t('checkout.serialsRequired')}`}
                  </button>
                )}

                <p className="numeric mt-1 text-end text-sm font-semibold text-neutral-800">
                  {formatMoney(previewLineTotal(line.unitPrice, line.quantity, line.discountAmount))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {customer && canViewLoyalty && pointsQuery.data && (
        <div className="border-t border-neutral-200 px-4 py-2">
          <NumberField
            label={`${t('pos.redeemPoints')} (${t('pos.pointsAvailable')}: ${pointsQuery.data.data.balance})`}
            value={redeemPoints}
            min={0}
            max={parseMoney(pointsQuery.data.data.balance)}
            onChange={setRedeemPoints}
          />
        </div>
      )}

      <div className="border-t border-neutral-200 px-4 py-3">
        <div className="flex justify-between text-sm text-neutral-600">
          <span>{t('pos.subtotal')}</span>
          <span className="numeric">{formatMoney(estimateSubtotal)}</span>
        </div>
        <div className="flex justify-between text-sm text-neutral-600">
          <span>{t('pos.discount')}</span>
          <span className="numeric">-{formatMoney(estimateDiscount)}</span>
        </div>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-base font-bold text-neutral-900">{t('pos.total')}</span>
          <span className="numeric text-lg font-extrabold text-brand-700">{formatMoney(estimateTotal)}</span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-neutral-400">{t('pos.estimateNotice')}</p>

        {missingSerials && <Badge tone="warning" className="mt-2">{t('checkout.serialsRequired')}</Badge>}

        <Button fullWidth size="lg" className="mt-3" disabled={lines.length === 0 || missingSerials} onClick={onCheckout}>
          {t('pos.checkout')}
        </Button>
      </div>

      <CustomerPickerModal
        open={customerPickerOpen}
        onClose={() => setCustomerPickerOpen(false)}
        onSelect={(c) => {
          setCustomer(c);
          setCustomerPickerOpen(false);
        }}
      />
      <SerialCaptureModal
        line={serialLine ? { productName: serialLine.productName, quantity: serialLine.quantity, serials: serialLine.serials } : null}
        onClose={() => setSerialLine(null)}
        onSave={(serials) => {
          if (serialLine) setSerials(serialLine.key, serials);
          setSerialLine(null);
        }}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <Input
      label={label}
      type="number"
      className="numeric w-24"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
