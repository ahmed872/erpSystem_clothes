import type { WarrantyClaim, WarrantyClaimStatus, WarrantyStatus } from './apiTypes';

/**
 * Phase 13 (ERP slice) — the only warranty logic in the ERP browser, and
 * it decides nothing.
 *
 * THERE IS NO ELIGIBILITY CHECK HERE, AND THERE MUST NEVER BE ONE. Whether
 * a warranty is in date is `effectiveWarrantyStatus` on the server,
 * computed from the warranty's own snapshotted dates; whether a claim may
 * be resolved is `ResolveWarrantyClaimUseCase`, which refuses anything not
 * OPEN and refuses a concurrent second resolution. These helpers only read
 * statuses the server sent.
 */

/** A claim can be acted on only while it is OPEN — the backend's own rule
 *  (`claim.status !== 'OPEN'` is a 409), mirrored so the UI does not offer
 *  a control that must fail. The server re-checks regardless. */
export function isResolvable(claim: WarrantyClaim): boolean {
  return claim.status === 'OPEN';
}

/** Tone for a claim's status badge. Maps; adds no meaning. */
export function claimTone(status: WarrantyClaimStatus): 'warning' | 'success' | 'neutral' {
  if (status === 'OPEN') return 'warning';
  if (status === 'RESOLVED') return 'success';
  return 'neutral';
}

/** Tone for a warranty's SERVER-DERIVED effective status. */
export function warrantyTone(status: WarrantyStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'CLAIMED':
      return 'warning';
    case 'VOID':
      return 'danger';
    default:
      return 'neutral';
  }
}
