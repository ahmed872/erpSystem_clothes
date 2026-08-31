import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, ErrorBanner, SpinnerOverlay } from '@retail/ui-kit';
import { salesApi } from '../api/sales';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';

export function ReceiptPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { saleId } = useParams<{ saleId: string }>();

  const query = useQuery({
    queryKey: ['receipt', saleId],
    queryFn: () => salesApi.receipt(saleId!),
    enabled: Boolean(saleId),
  });

  if (query.isLoading) return <SpinnerOverlay />;
  if (query.isError) {
    const { title, message } = describeError(query.error);
    return (
      <div className="p-6">
        <ErrorBanner title={title} message={message} />
      </div>
    );
  }

  const receipt = query.data!.data;

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-neutral-100 p-4">
      <Card className="w-full max-w-sm print:border-0 print:shadow-none">
        <CardBody className="flex flex-col gap-3 p-5 text-sm">
          <div className="text-center">
            <p className="text-base font-bold">{receipt.business.displayName}</p>
            {receipt.business.addressLine && <p className="text-xs text-neutral-500">{receipt.business.addressLine}</p>}
            {receipt.business.phone && <p className="text-xs text-neutral-500">{receipt.business.phone}</p>}
            {receipt.business.receiptHeader && <p className="mt-1 text-xs text-neutral-500">{receipt.business.receiptHeader}</p>}
          </div>

          <div className="border-t border-dashed border-neutral-300 pt-2 text-xs text-neutral-500">
            <div className="flex justify-between">
              <span>{t('receipt.saleNumber')}</span>
              <span className="numeric font-semibold text-neutral-800">{receipt.sale.saleNumber}</span>
            </div>
            <div className="flex justify-between">
              <span>{new Date(receipt.sale.createdAt).toLocaleString()}</span>
              {receipt.cashier && <span>{receipt.cashier.name}</span>}
            </div>
            {receipt.customer && (
              <div className="flex justify-between">
                <span>{t('pos.customer')}</span>
                <span>{receipt.customer.name}</span>
              </div>
            )}
          </div>

          <table className="w-full border-t border-dashed border-neutral-300 pt-2 text-xs">
            <tbody>
              {receipt.items.map((item) => (
                <tr key={item.id} className="align-top">
                  <td className="py-1 pe-2">
                    <div className="font-medium text-neutral-800">{item.name}</div>
                    <div className="numeric text-neutral-400">
                      {item.quantity} × {formatMoney(item.unitPrice)}
                    </div>
                    {item.serials.length > 0 && (
                      <div className="numeric text-[10px] text-neutral-400">SN: {item.serials.join(', ')}</div>
                    )}
                  </td>
                  <td className="numeric py-1 text-end font-semibold">{formatMoney(item.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="border-t border-dashed border-neutral-300 pt-2">
            <Row label={t('pos.subtotal')} value={receipt.sale.subtotal} />
            <Row label={t('pos.discount')} value={`-${formatMoney(receipt.sale.discountAmount)}`} raw />
            <Row label={t('pos.tax')} value={receipt.sale.taxAmount} />
            <div className="mt-1 flex items-baseline justify-between border-t border-neutral-300 pt-1">
              <span className="font-bold">{t('pos.total')}</span>
              <span className="numeric text-lg font-extrabold">{formatMoney(receipt.sale.totalAmount)}</span>
            </div>
          </div>

          {receipt.payments.length > 0 && (
            <div className="border-t border-dashed border-neutral-300 pt-2">
              {receipt.payments.map((p, i) => (
                <Row key={i} label={p.method} value={p.amount} />
              ))}
            </div>
          )}

          {(Number(receipt.loyalty.earned) > 0 || Number(receipt.loyalty.redeemed) > 0) && (
            <div className="border-t border-dashed border-neutral-300 pt-2 text-xs text-neutral-500">
              {Number(receipt.loyalty.earned) > 0 && <Row label={t('receipt.pointsEarned')} value={receipt.loyalty.earned} raw />}
              {Number(receipt.loyalty.redeemed) > 0 && <Row label={t('receipt.pointsRedeemed')} value={receipt.loyalty.redeemed} raw />}
            </div>
          )}

          {receipt.business.receiptFooter && (
            <p className="border-t border-dashed border-neutral-300 pt-2 text-center text-xs text-neutral-400">
              {receipt.business.receiptFooter}
            </p>
          )}
        </CardBody>
      </Card>

      <div className="mt-4 flex w-full max-w-sm gap-2 print:hidden">
        <Button variant="secondary" fullWidth onClick={() => window.print()}>
          {t('receipt.print')}
        </Button>
        <Button fullWidth onClick={() => navigate('/pos')}>
          {t('receipt.newSale')}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value, raw }: { label: string; value: string; raw?: boolean }) {
  return (
    <div className="flex justify-between text-xs text-neutral-600">
      <span>{label}</span>
      <span className="numeric">{raw ? value : formatMoney(value)}</span>
    </div>
  );
}
