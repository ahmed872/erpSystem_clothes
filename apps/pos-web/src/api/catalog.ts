import { api } from '../lib/apiClient';
import type { Paginated, Product, ProductVariant } from '../lib/apiTypes';

export const catalogApi = {
  searchProducts: (search: string, page = 1, limit = 20) =>
    api.get<Paginated<Product & { variants: Array<{ id: string; sku: string; status: string }> }>>(
      `/catalog/products?search=${encodeURIComponent(search)}&page=${page}&limit=${limit}`,
    ),
  /**
   * `GET /catalog/products/:id` nests variants WITHOUT a `product` back-
   * reference on each one (unlike the barcode/SKU lookup route, which
   * does) — the server's `PRODUCT_INCLUDE` simply doesn't select it,
   * since the parent object already carries the product fields once.
   * Every other part of this app (cart, receipts) expects
   * `ProductVariant.product` to always be present (it's what the barcode
   * scan path naturally returns), so it's attached here, in the one place
   * that fetches this shape, rather than requiring every caller to know
   * about the inconsistency.
   */
  getProduct: async (id: string): Promise<{ data: Product & { variants: ProductVariant[] } }> => {
    const { data } = await api.get<{ data: Product & { variants: Array<Omit<ProductVariant, 'product'>> } }>(
      `/catalog/products/${id}`,
    );
    return { data: { ...data, variants: data.variants.map((v) => ({ ...v, product: data })) } };
  },
  lookupByBarcode: (barcode: string) =>
    api.get<{ data: ProductVariant }>(`/catalog/variants/lookup?barcode=${encodeURIComponent(barcode)}`),
  lookupBySku: (sku: string) => api.get<{ data: ProductVariant }>(`/catalog/variants/lookup?sku=${encodeURIComponent(sku)}`),
};
