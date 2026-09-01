import { describe, expect, it } from 'vitest';
import * as priceLists from './priceLists';
import { applicablePriceList, priceListRole, priceListTone, promotionChangesPricing } from './priceLists';
import type { PriceList } from './apiTypes';

/**
 * Phase 14.
 *
 * The first case is the point of the module and is asserted
 * mechanically: this file exports NO price resolver. What a line sells
 * for is `resolveSellingPrice` on the server; a second implementation in
 * a browser would be free to disagree with the figure the customer is
 * actually charged.
 */

function list(over: Partial<PriceList> = {}): PriceList {
  return {
    id: 'pl-1',
    name: 'Retail',
    isDefault: false,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('the module boundary', () => {
  it('exports no price resolver, and must never gain one', () => {
    for (const name of Object.keys(priceLists)) {
      expect(name).not.toMatch(/resolve|calculate|compute/i);
    }
    expect(Object.keys(priceLists)).not.toContain('resolvePrice');
  });
});

describe('applicablePriceList', () => {
  it('is the one list that is BOTH default and active', () => {
    // Mirrors `loadConfiguredPrices` exactly: findFirst({ isDefault: true,
    // isActive: true }). Nothing else in the live schema selects a list.
    const lists = [list({ id: 'a' }), list({ id: 'b', isDefault: true }), list({ id: 'c', isActive: false })];
    expect(applicablePriceList(lists)?.id).toBe('b');
  });

  it('is NULL when the default list has been deactivated', () => {
    // The case worth naming. The backend finds no list, so every till's
    // own price stands — a manager looking at a screenful of configured
    // prices would otherwise believe they were being enforced.
    expect(applicablePriceList([list({ isDefault: true, isActive: false })])).toBeNull();
  });

  it('is NULL when a tenant has active lists but no default', () => {
    expect(applicablePriceList([list({ id: 'a' }), list({ id: 'b' })])).toBeNull();
  });

  it('is NULL for a tenant with no lists at all', () => {
    expect(applicablePriceList([])).toBeNull();
  });

  it('ignores every signal other than isDefault and isActive', () => {
    // There is no customer-, branch- or warehouse-scoped price list in the
    // live schema, and this milestone does not invent one. A list carries
    // exactly two booleans and a name.
    const only = list({ isDefault: true, isActive: true, name: 'VIP' });
    expect(applicablePriceList([only])?.id).toBe(only.id);
    expect(Object.keys(only).sort()).toEqual(['createdAt', 'id', 'isActive', 'isDefault', 'name']);
  });
});

describe('priceListRole', () => {
  it('names all four states a list can be in', () => {
    expect(priceListRole(list({ isDefault: true, isActive: true }))).toBe('APPLICABLE');
    expect(priceListRole(list({ isDefault: true, isActive: false }))).toBe('INERT');
    expect(priceListRole(list({ isDefault: false, isActive: true }))).toBe('STANDBY');
    expect(priceListRole(list({ isDefault: false, isActive: false }))).toBe('INACTIVE');
  });

  it('warns on INERT — a default that no longer applies is not a neutral state', () => {
    expect(priceListTone('INERT')).toBe('warning');
    expect(priceListTone('APPLICABLE')).toBe('success');
    expect(priceListTone('STANDBY')).toBe('neutral');
    expect(priceListTone('INACTIVE')).toBe('neutral');
  });

  it('agrees with applicablePriceList on which single list is in force', () => {
    const lists = [list({ id: 'a' }), list({ id: 'b', isDefault: true }), list({ id: 'c', isActive: false })];
    const inForce = lists.filter((l) => priceListRole(l) === 'APPLICABLE');
    expect(inForce).toHaveLength(1);
    expect(inForce[0].id).toBe(applicablePriceList(lists)!.id);
  });
});

describe('promotionChangesPricing', () => {
  it('is true when another list is currently in force', () => {
    const current = list({ id: 'a', isDefault: true });
    const candidate = list({ id: 'b' });
    expect(promotionChangesPricing(candidate, [current, candidate])).toBe(true);
  });

  it('is true when NOTHING is in force — promoting starts enforcing prices', () => {
    const candidate = list({ id: 'b' });
    expect(promotionChangesPricing(candidate, [candidate])).toBe(true);
  });

  it('is false for the list that is already the default', () => {
    const current = list({ id: 'a', isDefault: true });
    expect(promotionChangesPricing(current, [current])).toBe(false);
  });
});
