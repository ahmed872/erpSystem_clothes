import { describe, expect, it } from 'vitest';
import * as reports from './reports';
import {
  FINANCIAL_VIEW_IMPLIES_PROFIT,
  PROFIT_AND_LOSS_IS_BUSINESS_WIDE,
  RANGELESS_REPORTS,
  RANGE_IS_HALF_OPEN,
  damageTone,
  dimensionHasOnlyRevenue,
  dimensionSupportsWarehouse,
  hasCogs,
  hasGrossProfit,
  hasOutstanding,
  isBalanced,
  isReconciled,
  isWalkInReturn,
  ledgerSide,
  limitationEntries,
  movementTone,
  neverSold,
  rowsCarryCost,
  rowsCarryProfit,
  valuationHasValue,
} from './reports';
import type { SalesDimension } from '../api/reports';
import type { BalanceSheetResult, ReconciliationResult } from './apiTypes';

/**
 * Phase 19.
 *
 * The first case is the point of the module and is asserted
 * mechanically: this file exports NO report calculator. Every figure a
 * report screen prints was aggregated by the server inside one
 * transaction, over ledgers the browser never holds in full, on a
 * historical cost basis (`unitCostAtMovement`) it cannot reconstruct.
 * Adding a page of rows together here would produce a number that looks
 * authoritative, disagrees with the server's, and is wrong the moment
 * there is a second page.
 */

describe('the module boundary', () => {
  it('exports no report calculator, and must never gain one', () => {
    for (const name of Object.keys(reports)) {
      expect(name).not.toMatch(/sum|total|aggregate|calculate|compute|cogsOf|profitOf|margin|valueOf|bucket|groupBy/i);
    }
  });

  it('records the date contract rather than reimplementing it', () => {
    // The server resolves from/to in the BUSINESS's timezone into a
    // half-open interval and echoes the window it used. The screens send
    // two calendar dates and print that echo; nothing here computes a
    // boundary or assumes UTC.
    expect(RANGE_IS_HALF_OPEN).toBe(true);
  });

  it('lists the reports that accept no date range, so none offers a date control', () => {
    // The schemas are not strict: `from`/`to` sent to these is DROPPED
    // while the request still succeeds, so an inert control would be
    // worse than an absent one.
    expect([...RANGELESS_REPORTS]).toContain('inventory/valuation');
    expect([...RANGELESS_REPORTS]).toContain('inventory/slow-moving');
    expect([...RANGELESS_REPORTS]).toContain('financial/balance-sheet');
    expect([...RANGELESS_REPORTS]).toContain('financial/receivables');
    expect([...RANGELESS_REPORTS]).toContain('financial/payables');
    expect([...RANGELESS_REPORTS]).toContain('reconciliation');
    expect([...RANGELESS_REPORTS]).not.toContain('sales/summary');
    expect([...RANGELESS_REPORTS]).not.toContain('inventory/movements');
  });

  it('records that the P&L is business-wide, so no branch picker is offered', () => {
    // It ACCEPTS `branchId` and ignores it: the General Ledger it is
    // derived from has no branch dimension.
    expect(PROFIT_AND_LOSS_IS_BUSINESS_WIDE).toBe(true);
  });

  it('records the Phase 19 owner decision where the screens can point at it', () => {
    // `reports.financial.view` IMPLIES visibility of the financial
    // reports' own contents. Scoped to that family alone — everywhere
    // else the server still deletes cost/profit keys and the screens ask
    // whether the payload carried them.
    expect(FINANCIAL_VIEW_IMPLIES_PROFIT).toBe(true);
  });
});

describe('warehouse support per dimension', () => {
  it('is true only where the server actually honours the parameter', () => {
    expect(dimensionSupportsWarehouse('by-product')).toBe(true);
    expect(dimensionSupportsWarehouse('by-category')).toBe(true);
    // Verified against the running server: these three accept it and
    // ignore it, so the screen shows no control rather than an inert one.
    expect(dimensionSupportsWarehouse('by-branch')).toBe(false);
    expect(dimensionSupportsWarehouse('by-user')).toBe(false);
    expect(dimensionSupportsWarehouse('by-payment-method')).toBe(false);
  });

  it('covers every dimension in the live contract', () => {
    const all: SalesDimension[] = ['by-product', 'by-category', 'by-branch', 'by-user', 'by-payment-method'];
    for (const d of all) expect(typeof dimensionSupportsWarehouse(d)).toBe('boolean');
  });
});

describe('dimensionHasOnlyRevenue', () => {
  it('names the breakdowns whose zeros are AUTHORITATIVE, not missing data', () => {
    // by-user groups whole Sale rows, which carry no per-line quantity or
    // cost, so the server returns the literal string '0'. The screen says
    // so instead of printing three zeros a reader would take as fact.
    expect(dimensionHasOnlyRevenue('by-user')).toBe(true);
    expect(dimensionHasOnlyRevenue('by-payment-method')).toBe(true);
    expect(dimensionHasOnlyRevenue('by-product')).toBe(false);
    expect(dimensionHasOnlyRevenue('by-category')).toBe(false);
    expect(dimensionHasOnlyRevenue('by-branch')).toBe(false);
  });
});

describe('cost and profit visibility', () => {
  it('asks whether the response CARRIED the figure, never whether a grant is held', () => {
    expect(hasCogs({ cogs: undefined })).toBe(false);
    expect(hasCogs({ cogs: '120' })).toBe(true);
    expect(hasGrossProfit({ grossProfit: undefined })).toBe(false);
    expect(hasGrossProfit({ grossProfit: '180' })).toBe(true);
  });

  it('shows a zero cost, which is a fact, rather than hiding it as absent', () => {
    expect(hasCogs({ cogs: '0' })).toBe(true);
    expect(hasGrossProfit({ grossProfit: '0' })).toBe(true);
  });

  it('decides a table column from the whole page, across every cost key', () => {
    expect(rowsCarryCost([])).toBe(false);
    expect(rowsCarryCost([{ quantityOnHand: '5' } as never])).toBe(false);
    expect(rowsCarryCost([{ averageCost: '40' }])).toBe(true);
    expect(rowsCarryCost([{ inventoryValue: '200' }])).toBe(true);
    expect(rowsCarryCost([{ unitCostAtMovement: '40' }])).toBe(true);
    expect(rowsCarryCost([{ movementValue: '80' }])).toBe(true);
    expect(rowsCarryCost([{ cogs: '120' }])).toBe(true);
    // One row carrying it is enough — the server strips per row, so a
    // mixed page cannot happen, but a column must not vanish if it did.
    expect(rowsCarryCost([{}, { averageCost: '40' }])).toBe(true);
  });

  it('decides the profit column the same way', () => {
    expect(rowsCarryProfit([])).toBe(false);
    expect(rowsCarryProfit([{ grossProfit: undefined }])).toBe(false);
    expect(rowsCarryProfit([{ grossProfit: '10' }])).toBe(true);
  });

  it('reports whether a valuation row carried its money columns', () => {
    expect(valuationHasValue({ inventoryValue: undefined })).toBe(false);
    expect(valuationHasValue({ inventoryValue: '0' })).toBe(true);
  });
});

describe('movement and damage tones', () => {
  it('reads a movement’s direction from the SIGN the ledger stored', () => {
    expect(movementTone({ quantityBase: '5', isNegativeStock: false })).toBe('success');
    expect(movementTone({ quantityBase: '-5', isNegativeStock: false })).toBe('warning');
  });

  it('flags a negative-stock movement above everything else', () => {
    // The server records that a movement drove stock below zero; that
    // fact outranks its direction.
    expect(movementTone({ quantityBase: '5', isNegativeStock: true })).toBe('danger');
    expect(movementTone({ quantityBase: '-5', isNegativeStock: true })).toBe('danger');
  });

  it('separates a write-off from an expiry from everything else', () => {
    expect(damageTone({ movementType: 'DAMAGE' })).toBe('danger');
    expect(damageTone({ movementType: 'LOSS' })).toBe('danger');
    expect(damageTone({ movementType: 'EXPIRY' })).toBe('warning');
    expect(damageTone({ movementType: 'INTERNAL_CONSUMPTION' })).toBe('neutral');
  });
});

describe('the general ledger', () => {
  it('names the side from the two stored figures, never by subtracting them', () => {
    expect(ledgerSide({ debit: '100', credit: '0' })).toBe('debit');
    expect(ledgerSide({ debit: '0', credit: '100' })).toBe('credit');
    expect(ledgerSide({ debit: '0', credit: '0' })).toBe('none');
  });
});

describe('party balances', () => {
  it('flags an outstanding balance in either direction', () => {
    expect(hasOutstanding({ balance: '100' })).toBe(true);
    expect(hasOutstanding({ balance: '-100' })).toBe(true);
    expect(hasOutstanding({ balance: '0' })).toBe(false);
    expect(hasOutstanding({ balance: 'x' })).toBe(false);
  });
});

describe('slow moving', () => {
  it('separates never sold from not sold lately', () => {
    expect(neverSold({ lastSaleAt: null })).toBe(true);
    expect(neverSold({ lastSaleAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
  });
});

describe('returns', () => {
  it('reads the walk-in flag the server set', () => {
    expect(isWalkInReturn({ isWalkIn: true })).toBe(true);
    expect(isWalkInReturn({ isWalkIn: false })).toBe(false);
  });
});

describe('reconciliation verdicts', () => {
  const recon = (summary: Record<string, unknown>) => ({ summary }) as unknown as ReconciliationResult;

  it('reads the SERVER’s verdict, never a comparison made here', () => {
    expect(isReconciled(recon({ reconciled: true }))).toBe(true);
    expect(isReconciled(recon({ reconciled: false }))).toBe(false);
  });

  it('falls back to the server’s own discrepancy count', () => {
    expect(isReconciled(recon({ discrepancyCount: 0 }))).toBe(true);
    expect(isReconciled(recon({ discrepancyCount: 3 }))).toBe(false);
  });

  it('returns null rather than guessing when the server stated neither', () => {
    // A report that reports no verdict must not be shown as reconciled:
    // re-deriving one here would be a second reconciliation engine.
    expect(isReconciled(recon({ sourceA: 'x' }))).toBeNull();
  });

  it('prefers the explicit flag over the count when both are present', () => {
    expect(isReconciled(recon({ reconciled: false, discrepancyCount: 0 }))).toBe(false);
  });
});

describe('the balance sheet', () => {
  it('reports the SERVER’s equation check rather than comparing totals here', () => {
    const sheet = (balanced: boolean) => ({ data: { balanced } }) as unknown as BalanceSheetResult;
    expect(isBalanced(sheet(true))).toBe(true);
    expect(isBalanced(sheet(false))).toBe(false);
  });
});

describe('limitationEntries', () => {
  it('renders the server’s written caveats, and nothing when there are none', () => {
    expect(limitationEntries(undefined)).toEqual([]);
    expect(limitationEntries({})).toEqual([]);
    expect(limitationEntries({ netProfit: 'not a complete figure' })).toEqual([['netProfit', 'not a complete figure']]);
  });
});
