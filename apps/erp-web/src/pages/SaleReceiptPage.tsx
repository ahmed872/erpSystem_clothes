import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ErrorBanner, Spinner } from '@retail/ui-kit';
import { salesApi } from '../api/sales';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { formatDateTime } from '../lib/datetime';
import { paymentTone } from '../lib/sales';

/**
 * Phase 17 — REPRINTING A RECEIPT.
 *
 * EVERY FIGURE IS READ, NOT RECOMPUTED. The receipt endpoint assembles
 * the document from what the sale STORED — each line's own tax amount and
 * rate snapshot, the sale's totals, the payment rows — so reprinting a
 * six-month-old sale shows the same numbers it showed then, even though
 * the tax rate, the price list and the promotion have all changed since.
 * That is the whole reason this is one endpoint rather than four calls
 * assembled in a browser.
 *
 * COST AND PROFIT ARE ABSENT FOR EVERYONE, including an owner: a receipt
 * is a document handed to a CUSTOMER, and the backend deliberately keeps
 * margin off it. The ERP does not add them back.
 *
 * PROMOTION PROVENANCE IS DISPLAYED, NEVER SUMMED. `promotions` names the
 * promotional part of a line's discount as it was at the time of sale;
 * those figures do NOT add up to `discountAmount`, because a manual
 * discount and a loyalty redemption live in it too. Adding them up here
 * would state something false.
 */
export function SaleReceiptPage() {
  const { t } = useTranslation();
  const { saleId = '' } = useParams();
  const navigate = useNavigate();

  const receipt = useQuery({ queryKey: ['receipt', saleId], queryFn: () => salesApi.receipt(saleId) });

  if (receipt.isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }
  if (receipt.isError) {
    return (
      <div className="mx-auto max-w-3xl p-4">
        <ErrorBanner {...describeError(receipt.error)} />
      </div>
    );
  }

  const r = receipt.data!.data;

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <h1 className="text-lg font-bold text-neutral-900">{t('sales.receipt')}</h1>
        <div className="flex items-center gap-2">
          {/* The browser's own print, on the document below. */}
          <Button variant="secondary" size="sm" onClick={() => window.print()} data-testid="print-receipt">
            {t('sales.print')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate(`/sales/${saleId}`)}>
            {t('sales.backToSale')}
          </Button>
        </div>
      </div>

      <Card>
        <CardBody className="p-5" data-testid="receipt-document">
          <div className="mb-4 text-center">
            <p className="text-base font-bold text-neutral-900">{r.business.displayName}</p>
            {r.business.receiptHeader && <p className="text-xs text-neutral-500">{r.business.receiptHeader}</p>}
            {r.business.taxNumber && (
              <p className="numeric text-xs text-neutral-500">
                {t('sales.taxNumber')}: {r.business.taxNumber}
              </p>
            )}
            <p className="text-xs text-neutral-500">
              {r.branch.name}
              {r.register ? ` · ${r.register.name}` : ''}
            </p>
          </div>

          <div className="mb-3 grid grid-cols-1 gap-x-6 gap-y-1 border-y border-neutral-200 py-2 sm:grid-cols-2">
            <Row label={t('sales.saleNumber')} value={r.sale.saleNumber} testId="receipt-number" />
            <Row label={t('sales.when')} value={formatDateTime(r.sale.createdAt)} />
            <Row label={t('sales.customer')} value={r.customer?.name ?? t('sales.walkIn')} />
            <Row label={t('sales.cashier')} value={r.cashier?.name ?? '—'} />
            {r.sale.exchangeForReturn && (
              <Row label={t('sales.exchangeFor')} value={r.sale.exchangeForReturn.returnNumber} />
            )}
          </div>

          <table className="mb-3 w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-xs uppercase text-neutral-500">
                <th className="py-1 text-start">{t('sales.item')}</th>
                <th className="py-1 text-end">{t('sales.quantity')}</th>
                <th className="py-1 text-end">{t('sales.unitPrice')}</th>
                <th className="py-1 text-end">{t('sales.lineTotal')}</th>
              </tr>
            </thead>
            <tbody data-testid="receipt-items">
              {r.items.map((item) => (
                <tr key={item.id} className="border-b border-neutral-100 align-top">
                  <td className="py-1">
                    <span className="font-medium">{item.name}</span>
                    {item.alternativeName && <span className="ms-2 text-xs text-neutral-400">{item.alternativeName}</span>}
                    <span className="numeric ms-2 text-xs text-neutral-400">{item.sku}</span>
                    {/* Why this line was cheaper, named as it was at the
                        time of sale — and never added up. */}
                    {item.promotions.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1" data-testid={`receipt-promotions-${item.sku}`}>
                        {item.promotions.map((p, i) => (
                          <span key={i} className="rounded-full bg-success-50 px-2 py-0.5 text-[11px] text-success-700">
                            {p.name} −{formatMoney(p.discountApplied)}
                          </span>
                        ))}
                      </div>
                    )}
                    {item.serials.length > 0 && (
                      <p className="numeric mt-0.5 text-[11px] text-neutral-400" data-testid={`receipt-serials-${item.sku}`}>
                        {item.serials.join(', ')}
                      </p>
                    )}
                    {Number(item.quantityReturned) > 0 && (
                      <p className="mt-0.5 text-[11px] font-semibold text-warning-700">
                        {t('sales.returned')}: {item.quantityReturned}
                      </p>
                    )}
                  </td>
                  <td className="numeric py-1 text-end">{item.quantity}</td>
                  <td className="numeric py-1 text-end">{formatMoney(item.unitPrice)}</td>
                  <td className="numeric py-1 text-end">{formatMoney(item.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mb-3 flex flex-col items-end gap-0.5 text-sm">
            <Total label={t('sales.subtotal')} value={r.sale.subtotal} />
            <Total label={t('sales.discount')} value={r.sale.discountAmount} />
            <Total label={t('sales.tax')} value={r.sale.taxAmount} />
            <Total label={t('sales.total')} value={r.sale.totalAmount} bold testId="receipt-total" />
            <Total label={t('sales.paid')} value={r.sale.paidAmount} />
            <Total label={t('sales.remaining')} value={r.sale.remainingAmount} />
            <Badge tone={paymentTone(r.sale.paymentStatus)}>{t(`sales.paymentLabel.${r.sale.paymentStatus}`)}</Badge>
          </div>

          {/* One row per RATE, built from each line's own snapshot. */}
          {r.taxBreakdown.length > 0 && (
            <div className="mb-3 border-t border-neutral-200 pt-2" data-testid="receipt-tax-breakdown">
              <p className="mb-1 text-xs font-semibold text-neutral-700">{t('sales.taxBreakdown')}</p>
              {r.taxBreakdown.map((b) => (
                <div key={b.ratePercent} className="flex justify-between text-xs text-neutral-600">
                  <span>{b.ratePercent}%</span>
                  <span className="numeric">
                    {formatMoney(b.taxableAmount)} → {formatMoney(b.taxAmount)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mb-3 border-t border-neutral-200 pt-2">
            <p className="mb-1 text-xs font-semibold text-neutral-700">{t('sales.payments')}</p>
            {r.payments.map((p, i) => (
              <div key={i} className="flex justify-between text-xs text-neutral-600">
                <span>{t(`sales.methodLabel.${p.method}`)}</span>
                <span className="numeric">{formatMoney(p.amount)}</span>
              </div>
            ))}
            {r.payments.length === 0 && <p className="text-xs text-neutral-400">{t('sales.noPayments')}</p>}
          </div>

          {(Number(r.loyalty.earned) > 0 || Number(r.loyalty.redeemed) > 0) && (
            <div className="mb-3 border-t border-neutral-200 pt-2 text-xs text-neutral-600" data-testid="receipt-loyalty">
              <div className="flex justify-between">
                <span>{t('sales.pointsEarned')}</span>
                <span className="numeric">{r.loyalty.earned}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('sales.pointsRedeemed')}</span>
                <span className="numeric">{r.loyalty.redeemed}</span>
              </div>
            </div>
          )}

          {/* What came back, so a customer holding this receipt can tell. */}
          {r.returns.length > 0 && (
            <div className="mb-3 border-t border-neutral-200 pt-2" data-testid="receipt-returns">
              <p className="mb-1 text-xs font-semibold text-neutral-700">{t('sales.returns')}</p>
              {r.returns.map((ret) => (
                <div key={ret.returnNumber} className="flex justify-between text-xs text-neutral-600">
                  <span className="numeric">{ret.returnNumber}</span>
                  <span className="numeric">{ret.refundAmount === null ? t('sales.onAccount') : formatMoney(ret.refundAmount)}</span>
                </div>
              ))}
            </div>
          )}

          {r.business.receiptFooter && (
            <p className="mt-4 text-center text-xs text-neutral-500">{r.business.receiptFooter}</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-neutral-500">{label}</span>
      <span className="numeric font-medium text-neutral-800" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function Total({ label, value, bold, testId }: { label: string; value: string; bold?: boolean; testId?: string }) {
  return (
    <div className={`flex w-full max-w-xs justify-between gap-6 ${bold ? 'font-bold text-neutral-900' : 'text-neutral-600'}`}>
      <span>{label}</span>
      <span className="numeric" data-testid={testId}>
        {formatMoney(value)}
      </span>
    </div>
  );
}
