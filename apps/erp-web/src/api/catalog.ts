import { api } from '../lib/apiClient';
import type {
  Barcode,
  BundleItem,
  ProductDetail,
  ProductListFilters,
  ProductListResult,
  Variant,
} from '../lib/apiTypes';

/**
 * Phase 14 — the catalogue, consumed exactly as the backend already
 * defines it.
 *
 * NOT ONE ENDPOINT WAS ADDED FOR THIS SCREEN. Products, variants,
 * barcodes and bundle composition all existed and were re-read before a
 * line of UI was written; what did not exist was any way to reach them
 * outside a REST client.
 *
 * NOTE THE THREE SEPARATE WRITE PATHS on a variant, which mirror three
 * separate grants: `PATCH :id` is `products.edit` (status, weight),
 * `PATCH :id/cost` is `products.change_cost`, and `PATCH :id/price` is
 * `products.change_price`. The backend split them deliberately — an
 * INVENTORY_MANAGER may set cost but not the shelf price — so this
 * client keeps them split rather than offering one convenient "save".
 */
export const catalogApi = {
  listProducts: (filters: ProductListFilters = {}) => {
    const q = new URLSearchParams();
    if (filters.search) q.set('search', filters.search);
    if (filters.categoryId) q.set('categoryId', filters.categoryId);
    if (filters.brandId) q.set('brandId', filters.brandId);
    if (filters.status) q.set('status', filters.status);
    if (filters.type) q.set('type', filters.type);
    q.set('page', String(filters.page ?? 1));
    q.set('limit', String(filters.limit ?? 20));
    return api.get<ProductListResult>(`/catalog/products?${q.toString()}`);
  },

  getProduct: (id: string) => api.get<{ data: ProductDetail }>(`/catalog/products/${id}`),

  /** `products.create`. A BUNDLE requires at least one component. */
  createProduct: (body: Record<string, unknown>) => api.post<{ data: ProductDetail }>('/catalog/products', body),

  /**
   * `products.edit`. Deliberately cannot change price or cost: the
   * product's `defaultCost`/`defaultSellingPrice` are creation-time seeds
   * for its variants, and the operationally meaningful figures live on the
   * VARIANT, changed through the two dedicated endpoints below. The
   * backend enforces this by simply not accepting those fields here.
   */
  updateProduct: (id: string, body: Record<string, unknown>) =>
    api.patch<{ data: ProductDetail }>(`/catalog/products/${id}`, body),

  /** `products.create` — a further variant on an existing product. */
  addVariant: (productId: string, body: Record<string, unknown>) =>
    api.post<{ data: Variant }>(`/catalog/products/${productId}/variants`, body),

  /** `products.edit` — status and physical attributes only. */
  updateVariant: (id: string, body: Record<string, unknown>) =>
    api.patch<{ data: Variant }>(`/catalog/variants/${id}`, body),

  /** `products.change_cost`, its own grant. Writes a ProductPriceHistory row. */
  changeVariantCost: (id: string, cost: number) =>
    api.patch<{ data: Variant }>(`/catalog/variants/${id}/cost`, { cost }),

  /** `products.change_price`, its own grant. Writes a ProductPriceHistory row. */
  changeVariantPrice: (id: string, sellingPrice: number) =>
    api.patch<{ data: Variant }>(`/catalog/variants/${id}/price`, { sellingPrice }),

  addBarcode: (variantId: string, code: string, isPrimary = false) =>
    api.post<{ data: Barcode }>(`/catalog/variants/${variantId}/barcodes`, { code, isPrimary }),

  removeBarcode: (barcodeId: string) => api.delete<{ data: unknown }>(`/catalog/barcodes/${barcodeId}`),

  /**
   * `products.edit`. REPLACES the whole composition — the backend's own
   * verb is PUT, and it validates every component server-side (a bundle
   * may not contain itself, components must exist in this tenant). The
   * browser sends a list and asserts nothing about what a bundle consumes
   * at sale time; `InventoryEngineService` owns that and is untouched.
   */
  replaceBundleItems: (productId: string, items: { variantId: string; quantity: number }[]) =>
    api.put<{ data: BundleItem[] }>(`/catalog/products/${productId}/bundle-items`, { items }),
};
