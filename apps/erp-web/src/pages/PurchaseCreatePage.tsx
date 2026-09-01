import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, ErrorBanner, Input, Select, Spinner } from '@retail/ui-kit';
import { purchasingApi } from '../api/purchasing';
import { inventoryApi } from '../api/inventory';
import { catalogApi } from '../api/catalog';
import { describeError } from '../lib/apiClient';

/**
 * Phase 16 — RAISING A PURCHASE ORDER.
 *
 * NO RUNNING TOTAL IS SHOWN, AND THAT IS DELIBERATE. The server computes
 * each `lineTotal` as `quantity x unitCost + tax - discount`, sums them
 * into `subtotal`, and derives `totalAmount` — in Decimal, at the
 * database's precision, inside the transaction that writes the document.
 * There is no purchase-quote endpoint to ask for those figures in
 * advance (the sale side has one; purchasing does not), so the honest
 * options were to add a browser calculator or to show none. A second
 * calculator would be free to disagree with the one that persists, which
 * is the mistake every milestone since Phase 12 has refused to make.
 *
 * So this form collects the lines, and the authoritative totals appear on
 * the order the server returns — a redirect away. The missing preview
 * endpoint is reported as a known limitation rather than papered over.
 *
 * The order is created as a DRAFT: nothing is committed to the supplier
 * and no stock moves until somebody with `purchases.approve` approves it
 * and somebody with `purchases.receive` receives it.
 */
export function PurchaseCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [warehouseId, setWarehouseId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<
    { variantId: string; quantityOrdered: string; unitCost: string; taxAmount: string; discountAmount: string }[]
  >([]);
  const [candidate, setCandidate] = useState('');
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  const warehouses = useQuery({ queryKey: ['warehouses'], queryFn: () => inventoryApi.listWarehouses() });
  const suppliers = useQuery({
    queryKey: ['suppliers', 'active'],
    queryFn: () => purchasingApi.listSuppliers({ isActive: true, limit: 200 }),
  });
  const products = useQuery({
    queryKey: ['products', 'purchasable'],
    queryFn: () => catalogApi.listProducts({ status: 'ACTIVE', limit: 100 }),
  });

  const create = useMutation({
    mutationFn: () =>
      purchasingApi.createPurchase({
        warehouseId,
        supplierId,
        // The schema wants a full ISO datetime; a date input gives a day.
        ...(expectedDate ? { expectedDate: new Date(`${expectedDate}T00:00:00.000Z`).toISOString() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        items: items.map((i) => ({
          variantId: i.variantId,
          quantityOrdered: Number(i.quantityOrdered || 0),
          unitCost: Number(i.unitCost || 0),
          taxAmount: Number(i.taxAmount || 0),
          discountAmount: Number(i.discountAmount || 0),
        })),
      }),
    onSuccess: (res) => navigate(`/purchases/${res.data.id}`),
    onError: (e) => setError(describeError(e)),
  });

  const variantOptions = (products.data?.data ?? []).flatMap((p) =>
    p.variants.filter((v) => v.status === 'ACTIVE').map((v) => ({ id: v.id, label: `${p.name} · ${v.sku}` })),
  );

  if (warehouses.isLoading || suppliers.isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }

  const ready =
    Boolean(warehouseId) &&
    Boolean(supplierId) &&
    items.length > 0 &&
    items.every((i) => Number(i.quantityOrdered) > 0);

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('purchases.newPurchase')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('purchases.newPurchaseExplainer')}</p>

      {error && <ErrorBanner title={error.title} message={error.message} />}

      <Card>
        <CardBody className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          <Select
            label={t('purchases.supplier')}
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            data-testid="create-supplier"
          >
            <option value="">{t('purchases.selectSupplier')}</option>
            {/* Only ACTIVE suppliers: the backend refuses an inactive one
                with a 422, so offering it would guarantee a failure. */}
            {(suppliers.data?.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select
            label={t('inventory.warehouse')}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            data-testid="create-warehouse"
          >
            <option value="">{t('transfers.selectWarehouse')}</option>
            {(warehouses.data?.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <Input
            label={t('purchases.expectedDate')}
            type="date"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
            data-testid="create-expected"
          />
          <Input label={t('purchases.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />

          <div className="sm:col-span-2">
            <p className="mb-1 text-sm font-semibold text-neutral-800">{t('purchases.lines')}</p>
            {/* Stated in the product, because its absence is otherwise
                surprising on an order form. */}
            <p className="mb-2 text-xs leading-snug text-neutral-500">{t('purchases.totalsHint')}</p>

            {items.map((item, idx) => (
              <div key={item.variantId} className="mb-2 rounded-lg border border-neutral-200 p-2">
                <p className="mb-1 truncate text-sm font-medium">
                  {variantOptions.find((v) => v.id === item.variantId)?.label ?? item.variantId}
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <Input
                    label={t('purchases.quantity')}
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    value={item.quantityOrdered}
                    onChange={(e) => {
                      const next = [...items];
                      next[idx] = { ...item, quantityOrdered: e.target.value };
                      setItems(next);
                    }}
                    className="w-28"
                    data-testid={`line-qty-${idx}`}
                  />
                  <Input
                    label={t('purchases.unitCost')}
                    type="number"
                    min="0"
                    step="0.0001"
                    value={item.unitCost}
                    onChange={(e) => {
                      const next = [...items];
                      next[idx] = { ...item, unitCost: e.target.value };
                      setItems(next);
                    }}
                    className="w-32"
                    data-testid={`line-cost-${idx}`}
                  />
                  <Input
                    label={t('purchases.tax')}
                    type="number"
                    min="0"
                    step="0.0001"
                    value={item.taxAmount}
                    onChange={(e) => {
                      const next = [...items];
                      next[idx] = { ...item, taxAmount: e.target.value };
                      setItems(next);
                    }}
                    className="w-28"
                    data-testid={`line-tax-${idx}`}
                  />
                  <Input
                    label={t('purchases.discount')}
                    type="number"
                    min="0"
                    step="0.0001"
                    value={item.discountAmount}
                    onChange={(e) => {
                      const next = [...items];
                      next[idx] = { ...item, discountAmount: e.target.value };
                      setItems(next);
                    }}
                    className="w-28"
                  />
                  <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, i) => i !== idx))}>
                    {t('common.remove')}
                  </Button>
                </div>
              </div>
            ))}

            <div className="flex flex-wrap items-end gap-2">
              <Select value={candidate} onChange={(e) => setCandidate(e.target.value)} data-testid="create-variant">
                <option value="">{t('catalogue.selectVariant')}</option>
                {variantOptions
                  .filter((v) => !items.some((i) => i.variantId === v.id))
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
              </Select>
              <Button
                variant="secondary"
                disabled={!candidate}
                onClick={() => {
                  setItems([
                    ...items,
                    { variantId: candidate, quantityOrdered: '1', unitCost: '0', taxAmount: '0', discountAmount: '0' },
                  ]);
                  setCandidate('');
                }}
                data-testid="create-add-line"
              >
                {t('common.add')}
              </Button>
            </div>
          </div>

          <div className="flex gap-2 sm:col-span-2">
            <Button
              loading={create.isPending}
              disabled={create.isPending || !ready}
              onClick={() => {
                setError(null);
                create.mutate();
              }}
              data-testid="create-submit"
            >
              {t('purchases.createDraft')}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/purchases')} disabled={create.isPending}>
              {t('common.cancel')}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
