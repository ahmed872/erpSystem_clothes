import { describe, expect, it } from 'vitest';
import { canRaiseClaim, statusTone, unitWarrantyState, unitsFromReceipt, warrantyForUnit } from './warrantyUnits';
import type { SaleReceipt, WarrantyListRow, WarrantyStatus } from './apiTypes';

/**
 * Phase 12 (Warranty).
 *
 * The most important assertion here is one that cannot be written as a
 * test case: there is no coverage check to call. Whether a warranty is in
 * date is `effectiveWarrantyStatus` on the server, computed from the
 * warranty's own snapshotted dates — never from the till's clock. What IS
 * tested below is that every helper only ever reads a status the server
 * sent, and that a unit is matched by BOTH its serial and its sale line.
 */

function receiptItem(over: Partial<SaleReceipt['items'][number]> = {}): SaleReceipt['items'][number] {
  return {
    id: 'si-1',
    sku: 'PH-001',
    name: 'Smartphone X1',
    alternativeName: null,
    quantity: '1',
    unitPrice: '500',
    discountAmount: '0',
    taxAmount: '0',
    taxRatePercent: null,
    taxExempt: false,
    lineTotal: '500',
    quantityReturned: '0',
    serials: ['SN-1'],
    serialUnits: [{ id: 'sn-id-1', serial: 'SN-1' }],
    ...over,
  };
}

function receipt(items: SaleReceipt['items']): SaleReceipt {
  return { items } as unknown as SaleReceipt;
}

function warranty(over: Partial<WarrantyListRow> = {}): WarrantyListRow {
  return {
    id: 'w1',
    saleItemId: 'si-1',
    serialNumberId: 'sn-id-1',
    customerId: null,
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2027-01-01T00:00:00.000Z',
    durationDays: 365,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    serialNumber: { id: 'sn-id-1', serial: 'SN-1' },
    customer: null,
    saleItem: { id: 'si-1', variantId: 'v1', sale: { id: 'sale-1', saleNumber: 'INV-1' } },
    claimCount: 0,
    ...over,
  };
}

describe('unitsFromReceipt', () => {
  it('offers exactly the units the SALE delivered, with the line that delivered them', () => {
    const units = unitsFromReceipt(receipt([receiptItem()]));
    expect(units).toEqual([
      {
        saleItemId: 'si-1',
        serialNumberId: 'sn-id-1',
        serial: 'SN-1',
        productName: 'Smartphone X1',
        alternativeName: null,
        sku: 'PH-001',
      },
    ]);
  });

  it('flattens several units across several lines', () => {
    const units = unitsFromReceipt(
      receipt([
        receiptItem({ id: 'si-1', serialUnits: [{ id: 'a', serial: 'SN-A' }, { id: 'b', serial: 'SN-B' }] }),
        receiptItem({ id: 'si-2', serialUnits: [{ id: 'c', serial: 'SN-C' }] }),
      ]),
    );
    expect(units.map((u) => [u.saleItemId, u.serial])).toEqual([
      ['si-1', 'SN-A'],
      ['si-1', 'SN-B'],
      ['si-2', 'SN-C'],
    ]);
  });

  it('offers NOTHING for a line with no serials — a warranty must name one physical unit', () => {
    expect(unitsFromReceipt(receipt([receiptItem({ serials: [], serialUnits: [] })]))).toEqual([]);
  });
});

describe('warrantyForUnit', () => {
  it('finds the warranty for this unit on this line', () => {
    expect(warrantyForUnit(unitsFromReceipt(receipt([receiptItem()]))[0], [warranty()])?.id).toBe('w1');
  });

  it('IGNORES a warranty for the same serial on a DIFFERENT sale line', () => {
    // The case that matters: a unit sold, returned (warranty auto-voided),
    // and sold again carries one warranty per line. Showing the earlier,
    // voided one against today's line would state the opposite of the truth.
    const unit = unitsFromReceipt(receipt([receiptItem({ id: 'si-2' })]))[0];
    const earlier = warranty({ id: 'old', saleItemId: 'si-1', effectiveStatus: 'VOID' });
    expect(warrantyForUnit(unit, [earlier])).toBeNull();
  });

  it('ignores a warranty for a different serial on the same line', () => {
    const unit = unitsFromReceipt(receipt([receiptItem()]))[0];
    expect(warrantyForUnit(unit, [warranty({ serialNumberId: 'other' })])).toBeNull();
  });

  it('is null when the server returned nothing', () => {
    expect(warrantyForUnit(unitsFromReceipt(receipt([receiptItem()]))[0], [])).toBeNull();
  });
});

describe('unitWarrantyState', () => {
  it('offers registration only when no warranty exists', () => {
    expect(unitWarrantyState(null)).toBe('UNREGISTERED');
  });

  it('treats ACTIVE, EXPIRED and CLAIMED alike as already registered', () => {
    // All three mean a warranty EXISTS here, and the unique index refuses a
    // second one regardless. Offering a register button for an expired
    // warranty would invite a cashier to try something that must fail.
    for (const s of ['ACTIVE', 'EXPIRED', 'CLAIMED'] as WarrantyStatus[]) {
      expect(unitWarrantyState(warranty({ effectiveStatus: s }))).toBe('REGISTERED');
    }
  });

  it('reports a VOID warranty as VOIDED, never as free to register again', () => {
    // The unique index still stands on (saleItemId, serialNumberId), so
    // "unregistered" would produce a 409 the cashier could not explain.
    expect(unitWarrantyState(warranty({ effectiveStatus: 'VOID' }))).toBe('VOIDED');
  });
});

describe('canRaiseClaim', () => {
  it('mirrors the server: a live or already-claimed warranty may take a claim', () => {
    expect(canRaiseClaim(warranty({ effectiveStatus: 'ACTIVE' }))).toBe(true);
    // A second claim in one period is explicitly allowed by the backend.
    expect(canRaiseClaim(warranty({ effectiveStatus: 'CLAIMED' }))).toBe(true);
  });

  it('offers no claim against a VOID or EXPIRED warranty, which the server refuses', () => {
    expect(canRaiseClaim(warranty({ effectiveStatus: 'VOID' }))).toBe(false);
    expect(canRaiseClaim(warranty({ effectiveStatus: 'EXPIRED' }))).toBe(false);
  });

  it('offers nothing when there is no warranty at all', () => {
    expect(canRaiseClaim(null)).toBe(false);
  });
});

describe('statusTone', () => {
  it('maps the server status to a tone and invents no meaning', () => {
    expect(statusTone('ACTIVE')).toBe('success');
    expect(statusTone('CLAIMED')).toBe('warning');
    expect(statusTone('VOID')).toBe('danger');
    expect(statusTone('EXPIRED')).toBe('neutral');
  });
});
