import { Prisma } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';

/**
 * Phase 12 (POS loose ends, approved decision D3) — THE SELLING PRICE IS
 * THE SHOP'S, NOT THE TILL'S.
 *
 * WHAT WAS WRONG. `POST /sales` and `POST /sales/quote` took `unitPrice`
 * from the request and priced the line with it. Price lists existed as
 * catalogue configuration and were consulted by nothing: a business could
 * configure a price and the till would still charge whatever its own copy
 * of the catalogue happened to say — a stale tab, a cached variant, or a
 * hand-edited request. The browser was the pricing authority in practice.
 *
 * WHAT APPLIES. The live model carries exactly one applicability signal:
 * `PriceList.isDefault` with `isActive`, and the tenant is held to at most
 * one default (proved in `catalog-price-lists.e2e-spec.ts`). There is no
 * customer-, branch- or warehouse-scoped price list in the schema, so the
 * applicable list is the ACTIVE DEFAULT one and nothing here invents a
 * richer rule. A variant with no configured price in that list has no
 * shop price to enforce, and the request's own figure stands — which is
 * every sale in the product today, so nothing pre-existing changes.
 *
 * THE OVERRIDE IS THE EXISTING PERMISSION, NOT A NEW ONE. A caller holding
 * `products.change_price` is trusted to sell at a price of their choosing
 * (a damaged-goods markdown, a haggled deal), exactly as the POS cart's
 * editable price field already assumes. A caller WITHOUT it gets the
 * configured price, whatever they sent.
 *
 * NOT A SECOND PRICING ENGINE. This resolves ONE number per line — the
 * unit price to price from — and then hands off. Tax, promotions, the
 * BD-12 cap and loyalty all run afterwards, unchanged, on whatever this
 * returns. And because the sale persists the price the PIPELINE resolved
 * (not the request's), a historical sale keeps the price it was sold at
 * forever: changing the price list later rewrites nothing.
 */

export interface ResolvedSellingPrice {
  /** The price to charge. */
  unitPrice: Prisma.Decimal;
  /** The configured shop price, when the applicable list has one. */
  configuredPrice: Prisma.Decimal | null;
  /** True when the caller's requested price was replaced by the shop's. */
  overriddenByPriceList: boolean;
}

/**
 * Loads the applicable price list's prices for the variants being sold.
 * One query for the list, one for the prices — never one per line.
 */
export async function loadConfiguredPrices(
  tx: TenantTx,
  businessId: string,
  variantIds: string[],
): Promise<Map<string, Prisma.Decimal>> {
  if (variantIds.length === 0) return new Map();

  const priceList = await tx.priceList.findFirst({
    where: { businessId, isDefault: true, isActive: true },
    select: { id: true },
  });
  if (!priceList) return new Map();

  const prices = await tx.productPrice.findMany({
    where: { businessId, priceListId: priceList.id, variantId: { in: variantIds } },
    select: { variantId: true, price: true },
  });
  return new Map(prices.map((p) => [p.variantId, p.price]));
}

/**
 * The price one line is actually sold at.
 *
 * `requestedUnitPrice` is honoured when there is no configured price, or
 * when the caller may legitimately override one. Otherwise the shop's
 * configured price wins — silently to the request, but never silently to
 * the CASHIER: the quote is computed from the same resolution, so the
 * figure on screen is already the one that will be charged.
 */
export function resolveSellingPrice(
  requestedUnitPrice: Prisma.Decimal.Value,
  configuredPrice: Prisma.Decimal | undefined,
  canOverride: boolean,
): ResolvedSellingPrice {
  const requested = new Prisma.Decimal(requestedUnitPrice);
  if (configuredPrice === undefined) {
    return { unitPrice: requested, configuredPrice: null, overriddenByPriceList: false };
  }
  if (canOverride) {
    return { unitPrice: requested, configuredPrice, overriddenByPriceList: false };
  }
  return {
    unitPrice: configuredPrice,
    configuredPrice,
    overriddenByPriceList: !configuredPrice.equals(requested),
  };
}
