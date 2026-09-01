import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge, Modal, Spinner } from '@retail/ui-kit';
import { inventoryApi } from '../../api/inventory';
import { formatMoney } from '../../lib/money';
import type { ProductVariant } from '../../lib/apiTypes';

export function VariantPickerModal({
  product,
  warehouseId,
  onClose,
  onSelect,
}: {
  product: { id: string; name: string; variants: ProductVariant[]; isBundle?: boolean } | null;
  warehouseId: string;
  onClose: () => void;
  onSelect: (variant: ProductVariant) => void;
}) {
  const { t } = useTranslation();

  return (
    <Modal open={Boolean(product)} onClose={onClose} title={product?.name} size="lg">
      {product && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {product.variants.map((variant) => (
            <VariantOption
              key={variant.id}
              variant={variant}
              warehouseId={warehouseId}
              isBundle={product.isBundle ?? false}
              onSelect={onSelect}
              t={t}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

/**
 * Phase 12 (D5): a BUNDLE variant carries NO stock balance of its own by
 * design — the components hold the stock — so the availability gate that
 * protects a simple variant would read every bundle as out of stock and
 * refuse to sell any of them. It is skipped here rather than replaced by a
 * browser-side component calculation: what a bundle's availability really
 * is remains the backend's answer, and it gives it by accepting or
 * refusing the sale (an atomic all-or-nothing consumption of every
 * component).
 */
function VariantOption({
  variant,
  warehouseId,
  isBundle,
  onSelect,
  t,
}: {
  variant: ProductVariant;
  isBundle: boolean;
  warehouseId: string;
  onSelect: (variant: ProductVariant) => void;
  t: (key: string) => string;
}) {
  const label = variant.attributeValues.map((av) => av.attributeValue.value).join(' / ') || variant.sku;
  const balanceQuery = useQuery({
    queryKey: ['balance', warehouseId, variant.id],
    queryFn: () => inventoryApi.balanceFor(warehouseId, variant.id),
    enabled: !isBundle,
  });
  const available = balanceQuery.data?.data[0]?.availableQuantity;
  const availableNum = available !== undefined ? Number(available) : undefined;
  const outOfStock = !isBundle && availableNum !== undefined && availableNum <= 0;

  return (
    <button
      type="button"
      disabled={outOfStock}
      onClick={() => onSelect(variant)}
      className="flex flex-col items-start gap-1 rounded-xl border border-neutral-200 p-3 text-start transition-colors hover:border-brand-400 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="text-sm font-semibold text-neutral-900">{label}</span>
      <span className="numeric text-sm text-brand-700">{formatMoney(variant.sellingPrice)}</span>
      {isBundle ? (
        <Badge tone="brand">{t('pos.bundle')}</Badge>
      ) : balanceQuery.isLoading ? (
        <Spinner />
      ) : outOfStock ? (
        <Badge tone="danger">{t('pos.outOfStock')}</Badge>
      ) : availableNum !== undefined ? (
        <Badge tone="success">
          {t('pos.available')}: {availableNum}
        </Badge>
      ) : null}
    </button>
  );
}
