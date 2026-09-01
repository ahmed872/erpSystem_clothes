import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, CardBody, ErrorBanner, Input, Spinner } from '@retail/ui-kit';
import { salesApi } from '../api/sales';
import { describeError } from '../lib/apiClient';
import { formatMoney } from '../lib/money';
import { usePermission } from '../hooks/usePermission';
import type { SaleListRow, SerialLookupResult } from '../lib/apiTypes';

/**
 * Phase 12 (POS loose ends) — FIND A PAST SALE, BY RECEIPT OR BY THE THING
 * ITSELF.
 *
 * Two loose ends met on one screen because they are the same act from the
 * cashier's side: a customer is standing there and the shop needs to find
 * what it sold them.
 *
 *   U4 — REPRINT. Receipts were reachable only by completing a sale, so a
 *        customer asking for another copy an hour later could not be
 *        served: `GET /sales/:id/receipt` existed and nothing led to it.
 *
 *   D4 — BY SERIAL. Every post-sale workflow began with the sale number on
 *        a receipt. A customer holding a serial-numbered unit and no
 *        receipt was unreachable, though the serial is stamped on the box
 *        in their hand.
 *
 * Both resolve to the same place — a sale — and hand off to the existing
 * Returns and Warranty screens rather than duplicating any of them. The
 * serial lookup is EXACT and this screen offers no way to browse: it takes
 * one serial and answers about one unit.
 */
type Found =
  | { kind: 'sale'; sale: SaleListRow }
  | { kind: 'serial'; result: SerialLookupResult };

export function LookupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canReturn = usePermission('sales.return');
  const canViewWarranty = usePermission('warranty.view');

  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  /**
   * ONE BOX, BOTH HANDLES. A cashier should not have to know whether what
   * they are holding is a sale number or a serial — they type or scan it
   * and the screen works it out. The sale number is tried first because it
   * is the cheaper, more common case; a serial lookup follows only when
   * that finds nothing. Neither is a guess: both are exact server lookups,
   * and if both miss, the screen says so rather than showing a near match.
   */
  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    const raw = term.trim();
    if (!raw) return;
    setSearching(true);
    setNotFound(false);
    setError(null);
    setFound(null);
    try {
      const byNumber = await salesApi.findByNumber(raw);
      if (byNumber.data.length > 0) {
        setFound({ kind: 'sale', sale: byNumber.data[0] });
        return;
      }
      try {
        const { data } = await salesApi.lookupSerial(raw);
        setFound({ kind: 'serial', result: data });
      } catch {
        // A 404 from the serial lookup means neither handle matched.
        setNotFound(true);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('lookup.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('lookup.explainer')}</p>

      <Card>
        <CardBody className="p-3">
          <form onSubmit={handleSearch} className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                label={t('lookup.field')}
                hint={t('lookup.fieldHint')}
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                className="numeric"
                autoFocus
                data-testid="lookup-term"
              />
            </div>
            <Button type="submit" loading={searching} disabled={searching || term.trim().length === 0} data-testid="lookup-search">
              {t('returns.searchAction')}
            </Button>
          </form>

          {searching && (
            <div className="mt-3 flex justify-center">
              <Spinner />
            </div>
          )}
          {notFound && (
            <p className="mt-2 text-sm font-medium text-danger-600" data-testid="lookup-not-found">
              {t('lookup.notFound')}
            </p>
          )}
          {error && (
            <div className="mt-2">
              <ErrorBanner title={error.title} message={error.message} />
            </div>
          )}
        </CardBody>
      </Card>

      {found?.kind === 'sale' && (
        <SaleResult
          saleNumber={found.sale.saleNumber}
          soldAt={found.sale.createdAt}
          total={found.sale.totalAmount}
          onReceipt={() => navigate(`/receipt/${found.sale.id}`)}
          canReturn={canReturn}
          onReturn={() => navigate('/returns')}
        />
      )}

      {found?.kind === 'serial' && (
        <SerialResult
          result={found.result}
          canReturn={canReturn}
          canViewWarranty={canViewWarranty}
          onReceipt={(saleId) => navigate(`/receipt/${saleId}`)}
          onWarranty={() => navigate('/warranty')}
          onReturn={() => navigate('/returns')}
        />
      )}
    </div>
  );
}

// ====================================================================
function SaleResult({
  saleNumber,
  soldAt,
  total,
  onReceipt,
  canReturn,
  onReturn,
}: {
  saleNumber: string;
  soldAt: string;
  total: string;
  onReceipt: () => void;
  canReturn: boolean;
  onReturn: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="mt-3">
      <CardBody className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="numeric text-sm font-bold text-neutral-900" data-testid="lookup-sale-number">
              {saleNumber}
            </p>
            <p className="text-xs text-neutral-500">{new Date(soldAt).toLocaleString()}</p>
          </div>
          <span className="numeric text-sm font-bold text-brand-700">{formatMoney(total)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onReceipt} data-testid="lookup-reprint">
            {t('lookup.viewReceipt')}
          </Button>
          {canReturn && (
            <Button size="sm" variant="secondary" onClick={onReturn}>
              {t('lookup.goToReturns')}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ====================================================================
/** One physical unit, and the sale that delivered it — or the honest
 * answer that this shop holds it but has not sold it. */
function SerialResult({
  result,
  canReturn,
  canViewWarranty,
  onReceipt,
  onWarranty,
  onReturn,
}: {
  result: SerialLookupResult;
  canReturn: boolean;
  canViewWarranty: boolean;
  onReceipt: (saleId: string) => void;
  onWarranty: () => void;
  onReturn: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="mt-3">
      <CardBody className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-neutral-900">{result.productName}</p>
            {result.alternativeName && <p className="text-xs text-neutral-500">{result.alternativeName}</p>}
            <p className="numeric text-xs text-neutral-500">{result.sku}</p>
            <p className="mt-1 text-xs text-neutral-700">
              {t('warranty.serial')}: <span className="numeric font-semibold" data-testid="lookup-serial">{result.serial}</span>
            </p>
          </div>
          <Badge tone={result.status === 'SOLD' ? 'neutral' : 'success'}>{t(`lookup.serialStatus.${result.status}`, { defaultValue: result.status })}</Badge>
        </div>

        {result.sale ? (
          <>
            <div className="rounded-lg bg-neutral-50 p-2.5 text-xs">
              <div className="flex justify-between gap-3">
                <span className="text-neutral-500">{t('lookup.soldOn')}</span>
                <span className="numeric font-semibold text-neutral-800" data-testid="lookup-serial-sale">
                  {result.sale.saleNumber}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-neutral-500">{t('returns.soldOn')}</span>
                <span className="font-semibold text-neutral-800">{new Date(result.sale.soldAt).toLocaleString()}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-neutral-500">{t('warranty.customer')}</span>
                <span className="font-semibold text-neutral-800">{result.sale.customer?.name ?? t('returns.walkInSale')}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onReceipt(result.sale!.id)} data-testid="lookup-serial-receipt">
                {t('lookup.viewReceipt')}
              </Button>
              {canViewWarranty && (
                <Button size="sm" variant="secondary" onClick={onWarranty} data-testid="lookup-serial-warranty">
                  {t('nav.warranty')}
                </Button>
              )}
              {canReturn && (
                <Button size="sm" variant="ghost" onClick={onReturn}>
                  {t('lookup.goToReturns')}
                </Button>
              )}
            </div>
          </>
        ) : (
          // Received but never sold. A true and useful answer at a counter:
          // this unit is ours, and nobody has bought it.
          <p className="text-xs leading-snug text-neutral-600" data-testid="lookup-serial-unsold">
            {t('lookup.serialNotSold')}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
