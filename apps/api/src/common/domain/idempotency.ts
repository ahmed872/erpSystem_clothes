import { ConflictDomainError } from '../errors/domain-error';

/**
 * Compares a canonical fingerprint of a new request against the
 * fingerprint of the row an idempotency key already matched, so a key
 * reused with a MATERIALLY DIFFERENT request is rejected (409) rather
 * than silently returning a stale result for an unrelated operation -
 * the exact gap a formal review found in the original implementation
 * (every idempotent lookup unconditionally returned the existing row,
 * regardless of whether the new request's payload matched it at all).
 * Both fingerprints must be built with the SAME field order/shape and
 * with every numeric value normalized through `Prisma.Decimal(...).
 * toString()` before being passed in, so "10" and "10.0000" compare
 * equal.
 */
export function assertIdempotentReplayMatches(existingFingerprint: unknown, newFingerprint: unknown): void {
  if (JSON.stringify(existingFingerprint) !== JSON.stringify(newFingerprint)) {
    throw new ConflictDomainError('This idempotency key was already used with a different request payload', {
      existing: existingFingerprint,
      requested: newFingerprint,
    });
  }
}
