import { KeyboardEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState, ErrorBanner, Input, Spinner } from '@retail/ui-kit';
import { catalogApi } from '../../api/catalog';
import { ApiError } from '../../lib/apiClient';
import { formatMoney } from '../../lib/money';
import { VariantPickerModal } from '../pos/VariantPickerModal';
import type { Product, ProductVariant } from '../../lib/apiTypes';

/**
 * Phase 12 (Exchange) — picking the REPLACEMENT item(s).
 *
 * Deliberately the same search/scan/variant-pick experience as the main
 * POS product search (`pages/pos/ProductSearchPanel.tsx`), not a second
 * one: same barcode-first Enter-to-add, same debounced text search, same
 * `VariantPickerModal` for a multi-variant product. The one difference is
 * where a picked variant goes — `onAdd`, a local draft list scoped to this
 * exchange, never the POS cart (`store/cartStore.ts`), which belongs to a
 * different, unrelated sale.
 */
export function NewItemPicker({ warehouseId, onAdd }: { warehouseId: string; onAdd: (variant: ProductVariant, unitPrice: number) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [pickerProduct, setPickerProduct] = useState<{
    id: string;
    name: string;
    variants: ProductVariant[];
    isBundle: boolean;
  } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  const query = useQuery({
    queryKey: ['exchange-products', debounced],
    queryFn: () => catalogApi.searchProducts(debounced),
    enabled: debounced.length > 0,
  });

  function addSingleVariant(variant: ProductVariant) {
    onAdd(variant, Number(variant.sellingPrice));
  }

  // Phase 12 (D5): a bundle is a replacement like any other - the sale
  // half of an exchange runs the same pipeline, which expands it.
  async function openProduct(product: Product & { variants: Array<{ id: string; sku: string; status: string }> }) {
    const { data } = await catalogApi.getProduct(product.id);
    if (data.variants.length === 1) {
      const variant = data.variants[0];
      if (variant) addSingleVariant(variant);
      return;
    }
    setPickerProduct({ id: data.id, name: data.name, variants: data.variants, isBundle: data.type === 'BUNDLE' });
  }

  async function handleScanKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || !search.trim()) return;
    setScanning(true);
    setScanError(null);
    try {
      const { data } = await catalogApi.lookupByBarcode(search.trim());
      addSingleVariant(data);
      setSearch('');
      setDebounced('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Not a barcode - leave it as free text for the debounced search.
      } else if (err instanceof ApiError) {
        setScanError(err.message);
      }
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        placeholder={t('pos.searchPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={handleScanKeyDown}
        endAdornment={scanning ? <Spinner /> : undefined}
        data-testid="exchange-product-search"
      />

      {scanError && <ErrorBanner title={scanError} />}

      {query.isFetching && (
        <div className="flex justify-center p-3">
          <Spinner />
        </div>
      )}
      {!query.isFetching && debounced && (query.data?.data.length ?? 0) === 0 && <EmptyState title={t('common.noResults')} />}

      {debounced && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {query.data?.data.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => void openProduct(product)}
              className="flex flex-col items-start gap-1 rounded-lg border border-neutral-200 bg-white p-2.5 text-start text-sm shadow-sm hover:border-brand-400"
              data-testid={`exchange-new-item-${product.sku}`}
            >
              <span className="line-clamp-2 font-semibold text-neutral-900">{product.name}</span>
              <div className="flex w-full items-center justify-between">
                <span className="numeric text-brand-700">{formatMoney(product.defaultSellingPrice)}</span>
                {product.variants.length > 1 && <Badge tone="brand">{product.variants.length}</Badge>}
              </div>
            </button>
          ))}
        </div>
      )}

      <VariantPickerModal
        product={pickerProduct}
        warehouseId={warehouseId}
        onClose={() => setPickerProduct(null)}
        onSelect={(variant) => {
          setPickerProduct(null);
          addSingleVariant(variant);
        }}
      />
    </div>
  );
}
