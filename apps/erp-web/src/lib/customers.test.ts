import { describe, expect, it } from 'vitest';
import * as customers from './customers';
import {
  CUSTOMER_FIELDS,
  CUSTOMER_LIST_FILTERS,
  CUSTOMER_REACTIVATION_UNSUPPORTED,
  CUSTOMER_TRANSACTION_CAP,
  canDeactivateCustomer,
  contactLine,
  customerTone,
  hasLoyaltyHistory,
  inCredit,
  ledgerDirection,
  ledgerMayBeTruncated,
  owesBusiness,
  pointsAdded,
  pointsTone,
  transactionTone,
} from './customers';
import type { CustomerDetail, CustomerPointsType, CustomerRow, CustomerTransactionType } from './apiTypes';

/**
 * Phase 18.
 *
 * The first case is the point of the module and is asserted
 * mechanically: this file exports NO balance or points calculator. A
 * customer's account balance is `SUM(CustomerTransaction.amount)` and
 * their points balance is `SUM(CustomerPoints.points)`, both derived by
 * the server on every read from ledgers this app never holds in full.
 * Summing a fetched PAGE of either would produce a figure that looks
 * authoritative and is wrong the moment there is a second page.
 */

function customer(over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'c-1',
    name: 'Layla Hassan',
    phone: '01000000009',
    email: 'layla@example.test',
    address: null,
    taxNumber: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    balance: '0',
    ...over,
  };
}

describe('the module boundary', () => {
  it('exports no balance or points calculator, and must never gain one', () => {
    for (const name of Object.keys(customers)) {
      expect(name).not.toMatch(/sum|total|subtotal|calculate|compute|lifetime|spend|aggregate/i);
    }
  });

  it('offers exactly the two filters the live list query accepts', () => {
    // `customerListQuerySchema` takes `search`, `isActive`, `page` and
    // `limit`. There is no email filter, no balance filter and no
    // ordering parameter — and because the schema is non-strict, an
    // unknown key is DROPPED rather than rejected, so a control for one
    // would silently do nothing.
    expect([...CUSTOMER_LIST_FILTERS]).toEqual(['search', 'isActive']);
    expect([...CUSTOMER_LIST_FILTERS]).not.toContain('email');
    expect([...CUSTOMER_LIST_FILTERS]).not.toContain('hasBalance');
    expect([...CUSTOMER_LIST_FILTERS]).not.toContain('sort');
  });

  it('writes exactly the five fields the create/update schemas accept', () => {
    // The absence that matters: no `creditLimit` — there is no such
    // column on the model and no such key in either schema — and no
    // `isActive`, which is not writable through PATCH at all.
    expect([...CUSTOMER_FIELDS]).toEqual(['name', 'phone', 'email', 'address', 'taxNumber']);
    expect([...CUSTOMER_FIELDS]).not.toContain('creditLimit');
    expect([...CUSTOMER_FIELDS]).not.toContain('isActive');
    expect([...CUSTOMER_FIELDS]).not.toContain('balance');
  });

  it('records that deactivation is one-way in the live contract', () => {
    // `PATCH {isActive: true}` returns 200 having changed nothing,
    // because the schema drops the key. Offering a reactivate control
    // would report success and leave the customer inactive.
    expect(CUSTOMER_REACTIVATION_UNSUPPORTED).toBe(true);
  });

  it('records the server cap on the account ledger it returns', () => {
    expect(CUSTOMER_TRANSACTION_CAP).toBe(100);
  });
});

describe('customerTone and deactivation', () => {
  it('separates an active customer from a deactivated one', () => {
    expect(customerTone(customer())).toBe('success');
    expect(customerTone(customer({ isActive: false }))).toBe('neutral');
  });

  it('offers deactivation only on an active customer — the server 409s otherwise', () => {
    expect(canDeactivateCustomer(customer())).toBe(true);
    expect(canDeactivateCustomer(customer({ isActive: false }))).toBe(false);
  });
});

describe('the account balance', () => {
  it('reads the SERVER figure and only compares it against zero', () => {
    expect(owesBusiness(customer({ balance: '250.5' }))).toBe(true);
    expect(owesBusiness(customer({ balance: '0' }))).toBe(false);
    expect(owesBusiness(customer({ balance: '-40' }))).toBe(false);
  });

  it('names the negative case rather than showing it as nothing owed', () => {
    // A negative balance is the business holding the customer's money —
    // an overpayment, or return credit beyond what they owed. It is a
    // different fact from a settled account and is coloured differently.
    expect(inCredit(customer({ balance: '-40' }))).toBe(true);
    expect(inCredit(customer({ balance: '0' }))).toBe(false);
    expect(inCredit(customer({ balance: '40' }))).toBe(false);
  });

  it('refuses to guess on a value that is not a number', () => {
    expect(owesBusiness(customer({ balance: '' }))).toBe(false);
    expect(inCredit(customer({ balance: 'x' }))).toBe(false);
  });

  it('treats a settled account as neither owing nor in credit', () => {
    const settled = customer({ balance: '0' });
    expect(owesBusiness(settled)).toBe(false);
    expect(inCredit(settled)).toBe(false);
  });
});

describe('the account ledger', () => {
  it('reads direction from the SIGN the server stored, not from the row type', () => {
    expect(ledgerDirection({ amount: '100' })).toBe('up');
    expect(ledgerDirection({ amount: '-100' })).toBe('down');
    expect(ledgerDirection({ amount: '0' })).toBe('flat');
    expect(ledgerDirection({ amount: 'x' })).toBe('flat');
  });

  it('gives each transaction type its own tone', () => {
    expect(transactionTone('SALE')).toBe('brand');
    expect(transactionTone('PAYMENT')).toBe('success');
    expect(transactionTone('SALE_RETURN')).toBe('warning');
    expect(transactionTone('OPENING_BALANCE')).toBe('neutral');
    expect(transactionTone('ADJUSTMENT')).toBe('neutral');
  });

  it('covers every type in the live enum', () => {
    const all: CustomerTransactionType[] = ['SALE', 'SALE_RETURN', 'PAYMENT', 'OPENING_BALANCE', 'ADJUSTMENT'];
    for (const type of all) expect(['brand', 'success', 'warning', 'neutral']).toContain(transactionTone(type));
  });

  it('says when the page is the server’s cap rather than the whole history', () => {
    const rows = (n: number) =>
      ({ recentTransactions: Array.from({ length: n }, (_, i) => ({ id: String(i) })) }) as unknown as CustomerDetail;
    expect(ledgerMayBeTruncated(rows(0))).toBe(false);
    expect(ledgerMayBeTruncated(rows(99))).toBe(false);
    expect(ledgerMayBeTruncated(rows(100))).toBe(true);
  });
});

describe('loyalty', () => {
  it('gives each points event type its own tone', () => {
    expect(pointsTone('EARN')).toBe('success');
    expect(pointsTone('REDEEM')).toBe('warning');
    expect(pointsTone('RETURN_CLAWBACK')).toBe('danger');
    expect(pointsTone('ADJUSTMENT')).toBe('neutral');
  });

  it('covers every type in the live enum', () => {
    const all: CustomerPointsType[] = ['EARN', 'REDEEM', 'RETURN_CLAWBACK', 'ADJUSTMENT'];
    for (const type of all) expect(['success', 'warning', 'danger', 'neutral']).toContain(pointsTone(type));
  });

  it('reads whether an event added points from its SIGN, not its type', () => {
    // An ADJUSTMENT goes either way, which is exactly why the type does
    // not answer this and the stored sign does.
    expect(pointsAdded({ points: '50' })).toBe(true);
    expect(pointsAdded({ points: '-50' })).toBe(false);
    expect(pointsAdded({ points: 'x' })).toBe(false);
  });

  it('asks the SERVER’s event count whether there is any history', () => {
    // Not the length of the page we happen to hold: a filtered first page
    // can be empty for a customer with hundreds of events.
    expect(hasLoyaltyHistory({ eventCount: 0 })).toBe(false);
    expect(hasLoyaltyHistory({ eventCount: 1 })).toBe(true);
  });
});

describe('contactLine', () => {
  it('joins what exists and returns null when nothing does', () => {
    expect(contactLine({ phone: '0100', email: 'a@b.test' })).toBe('0100 · a@b.test');
    expect(contactLine({ phone: '0100', email: null })).toBe('0100');
    expect(contactLine({ phone: null, email: 'a@b.test' })).toBe('a@b.test');
    expect(contactLine({ phone: null, email: null })).toBeNull();
  });
});
