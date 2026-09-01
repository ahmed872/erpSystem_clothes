import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState, ErrorBanner, Input, Spinner } from '@retail/ui-kit';
import { catalogApi } from '../../api/catalog';
import { ApiError } from '../../lib/apiClient';
import { formatMoney } from '../../lib/money';
import { useCartStore } from '../../store/cartStore';
import { VariantPickerModal } from './VariantPickerModal';
import type { Product, ProductVariant } from '../../lib/apiTypes';

export function ProductSearchPanel({ warehouseId }: { warehouseId: string }) {
  const { t } = useTranslation();
  const addVariant = useCartStore((s) => s.addVariant);
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

  /**
   * Phase 12 (POS loose ends, U1) — THE SCANNER MUST NEVER LOSE THE
   * KEYBOARD.
   *
   * A barcode scanner is a keyboard that types very fast and presses
   * Enter. It has no idea what has focus. Every time the cashier clicked a
   * product card or picked a variant, focus moved to that button and the
   * next scan went nowhere — the cashier saw nothing happen, scanned
   * again, and eventually reached for the mouse. Focus is therefore
   * returned to the search box after every interaction that could have
   * taken it: adding a line, closing the picker, or finishing a scan.
   */
  const searchRef = useRef<HTMLInputElement>(null);
  const focusScanner = useCallback(() => {
    // After the click that triggered this has finished settling, so the
    // browser does not hand focus straight back to the button.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  const query = useQuery({
    queryKey: ['products', debounced],
    queryFn: () => catalogApi.searchProducts(debounced),
    enabled: debounced.length > 0,
  });

  function addSingleVariant(variant: ProductVariant) {
    addVariant(variant, Number(variant.sellingPrice));
    focusScanner();
  }

  /**
   * Phase 12 (approved decision D5 / U5) — A BUNDLE IS SOLD LIKE ANYTHING
   * ELSE.
   *
   * This used to `return` on a BUNDLE, so clicking one did nothing at all:
   * no line, no message, no clue. Bundles are part of the generic product
   * (a gift set, a phone-plus-case), and the backend has always sold them
   * — `consumeVariant` expands a BUNDLE line into its components and
   * consumes those, atomically, refusing the whole sale if any one of them
   * is short. So the bundle needs no special path here: its variant goes
   * into the cart exactly like a simple one, and the server does the rest.
   * Nothing about bundle composition or component stock is computed in
   * this browser.
   */
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
        // Not a barcode — leave it as free text, the debounced search below covers it.
      } else if (err instanceof ApiError) {
        setScanError(err.message);
      }
    } finally {
      setScanning(false);
      focusScanner();
    }
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <Input
        ref={searchRef}
        placeholder={t('pos.searchPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={handleScanKeyDown}
        autoFocus
        endAdornment={scanning ? <Spinner /> : undefined}
        data-testid="product-search"
      />
      <p className="text-xs text-neutral-400">{t('pos.scanHint')}</p>

      {scanError && <ErrorBanner title={scanError} />}

      <div className="flex-1 overflow-y-auto">
        {query.isFetching && (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        )}
        {query.isError && <ErrorBanner title={t('common.searchFailed')} message={(query.error as Error).message} />}
        {!query.isFetching && debounced && (query.data?.data.length ?? 0) === 0 && <EmptyState title={t('common.noResults')} />}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {query.data?.data.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => void openProduct(product)}
              className="flex flex-col items-start gap-1.5 rounded-xl border border-neutral-200 bg-white p-3 text-start shadow-sm transition-colors hover:border-brand-400 hover:shadow-md"
            >
              <span className="line-clamp-2 text-sm font-semibold text-neutral-900">{product.name}</span>
              <span className="text-xs text-neutral-400">{product.sku}</span>
              <div className="flex w-full items-center justify-between">
                <span className="numeric text-sm font-bold text-brand-700">{formatMoney(product.defaultSellingPrice)}</span>
                {product.type === 'BUNDLE' && <Badge tone="brand">{t('pos.bundle')}</Badge>}
                {product.variants.length > 1 && <Badge tone="neutral">{product.variants.length}</Badge>}
              </div>
            </button>
          ))}
        </div>
      </div>

      <VariantPickerModal
        product={pickerProduct}
        warehouseId={warehouseId}
        onClose={() => {
          setPickerProduct(null);
          focusScanner();
        }}
        onSelect={(variant) => {
          // A modal must always be closable by its own action, even if the
          // action it triggers throws — otherwise its backdrop is left
          // covering the screen with no way to dismiss it.
          setPickerProduct(null);
          addSingleVariant(variant);
        }}
      />
    </div>
  );
}
