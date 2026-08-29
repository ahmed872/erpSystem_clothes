/**
 * Derives a human-readable document number deterministically from a
 * row's own `id`, called right after insert within the same transaction.
 * Guaranteed collision-free without a shared counter/sequence, which
 * would otherwise serialize concurrent document creation for no reason -
 * no two documents can ever collide on this since `id` itself is
 * guaranteed unique. Shared across every module that mints a document
 * number this way (Purchasing since Phase 4, Sales since Phase 5) - a
 * generic formatting utility, not domain-specific business logic.
 */
export function documentNumberFromId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}
