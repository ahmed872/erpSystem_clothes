import { api } from '../lib/apiClient';
import type { Attribute, AttributeValue, Brand, Category, Tax, Uom } from '../lib/apiTypes';

/**
 * Phase 14 — the generic master data a catalogue is built from.
 *
 * DELIBERATELY GENERIC. There is no `size`, no `colour`, no `fabric` and
 * no clothing anything here, because there is none in the backend model
 * either: a tenant defines its own Attributes and their values, so a
 * clothing shop creates "Size"/"Colour" and an appliance dealer creates
 * "Capacity"/"Voltage" through the same screen. Hardcoding a garment's
 * vocabulary would make this a clothing product rather than a retail one.
 *
 * FIVE INDEPENDENT GRANTS. Categories, brands, attributes, units and taxes
 * each carry their own view/create/edit codes, and the roles genuinely
 * differ — an ACCOUNTANT holds `tax.manage` and none of the other four.
 * The setup screen therefore gates each tab separately rather than
 * treating "reference data" as one permission.
 */
export const referenceApi = {
  listCategories: () => api.get<{ data: Category[] }>('/catalog/categories'),
  createCategory: (body: { name: string; parentId?: string; description?: string }) =>
    api.post<{ data: Category }>('/catalog/categories', body),
  updateCategory: (id: string, body: { name?: string; isActive?: boolean; description?: string | null }) =>
    api.patch<{ data: Category }>(`/catalog/categories/${id}`, body),

  listBrands: () => api.get<{ data: Brand[] }>('/catalog/brands'),
  createBrand: (body: { name: string; description?: string }) => api.post<{ data: Brand }>('/catalog/brands', body),
  updateBrand: (id: string, body: { name?: string; isActive?: boolean; description?: string | null }) =>
    api.patch<{ data: Brand }>(`/catalog/brands/${id}`, body),

  listAttributes: () => api.get<{ data: Attribute[] }>('/catalog/attributes'),
  createAttribute: (body: { name: string }) => api.post<{ data: Attribute }>('/catalog/attributes', body),
  updateAttribute: (id: string, body: { name?: string; isActive?: boolean }) =>
    api.patch<{ data: Attribute }>(`/catalog/attributes/${id}`, body),
  createAttributeValue: (attributeId: string, body: { value: string; sortOrder?: number }) =>
    api.post<{ data: AttributeValue }>(`/catalog/attributes/${attributeId}/values`, body),
  /** `attributes.delete` — the ONE destructive verb in the whole catalogue
   *  contract. Everything else deactivates; see `lib/catalogue.ts`. */
  deleteAttributeValue: (id: string) => api.delete<{ data: unknown }>(`/catalog/attribute-values/${id}`),

  listUoms: () => api.get<{ data: Uom[] }>('/catalog/uoms'),
  createUom: (body: { name: string; code: string; precision?: number }) =>
    api.post<{ data: Uom }>('/catalog/uoms', body),
  updateUom: (id: string, body: { name?: string; precision?: number; isActive?: boolean }) =>
    api.patch<{ data: Uom }>(`/catalog/uoms/${id}`, body),

  /** `tax.view` / `tax.manage`. The ERP configures WHICH tax a product
   *  carries; the backend remains sole authority for the rate, the
   *  inclusive/exclusive mode and every computed tax amount. */
  listTaxes: () => api.get<{ data: Tax[] }>('/taxes'),
  createTax: (body: { name: string; ratePercent: number }) => api.post<{ data: Tax }>('/taxes', body),
  updateTax: (id: string, body: { name?: string; ratePercent?: number; isActive?: boolean }) =>
    api.patch<{ data: Tax }>(`/taxes/${id}`, body),
};
