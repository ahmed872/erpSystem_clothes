import { describe, expect, it } from 'vitest';
import { claimTone, isResolvable, warrantyTone } from './claims';
import type { WarrantyClaim, WarrantyClaimStatus, WarrantyStatus } from './apiTypes';

/**
 * Phase 13 (ERP slice).
 *
 * As with the POS's `warrantyUnits`, the most important property here is
 * one that cannot be written as a case: there is no coverage check to
 * call. Every helper reads a status the SERVER produced —
 * `effectiveWarrantyStatus` for the warranty, `ResolveWarrantyClaimUseCase`
 * for the claim — and none of them compares a date against the browser's
 * clock.
 */

function claim(over: Partial<WarrantyClaim> = {}): WarrantyClaim {
  return {
    id: 'c1',
    warrantyId: 'w1',
    claimedAt: '2026-03-01T00:00:00.000Z',
    description: 'Screen flickers',
    status: 'OPEN',
    resolution: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2026-03-01T00:00:00.000Z',
    ...over,
  };
}

describe('isResolvable', () => {
  it('offers the control only for an OPEN claim', () => {
    expect(isResolvable(claim())).toBe(true);
  });

  it('offers NOTHING for a claim already decided, which the server refuses with a 409', () => {
    // Mirrors `claim.status !== 'OPEN'` in ResolveWarrantyClaimUseCase.
    // Offering a button here would hand a manager an action that must
    // fail — and there is deliberately no path back to OPEN.
    expect(isResolvable(claim({ status: 'RESOLVED' }))).toBe(false);
    expect(isResolvable(claim({ status: 'REJECTED' }))).toBe(false);
  });

  it('reads the claim STATUS, never a resolvedAt timestamp', () => {
    // A claim that somehow carried a timestamp but was still OPEN is
    // still the server's to judge; the UI must not second-guess it by
    // inspecting a different field.
    expect(isResolvable(claim({ status: 'OPEN', resolvedAt: '2026-03-02T00:00:00.000Z' }))).toBe(true);
  });
});

describe('claimTone', () => {
  it('maps each claim status to a tone and invents no meaning', () => {
    const cases: [WarrantyClaimStatus, string][] = [
      ['OPEN', 'warning'],
      ['RESOLVED', 'success'],
      ['REJECTED', 'neutral'],
    ];
    for (const [status, tone] of cases) expect(claimTone(status)).toBe(tone);
  });
});

describe('warrantyTone', () => {
  it('maps the SERVER-DERIVED effective status, not the stored one', () => {
    const cases: [WarrantyStatus, string][] = [
      ['ACTIVE', 'success'],
      ['CLAIMED', 'warning'],
      ['VOID', 'danger'],
      ['EXPIRED', 'neutral'],
    ];
    for (const [status, tone] of cases) expect(warrantyTone(status)).toBe(tone);
  });

  it('gives EXPIRED a neutral tone, never a danger one', () => {
    // A warranty that simply ran its course is not an error state; VOID —
    // which the return path sets, BD-15 — is.
    expect(warrantyTone('EXPIRED')).not.toBe(warrantyTone('VOID'));
  });
});
