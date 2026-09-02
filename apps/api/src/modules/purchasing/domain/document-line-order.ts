import { Prisma } from '@prisma/client';

/**
 * Phase 22 (P21-1) — THE ORDER LINES COME BACK IN.
 *
 * A purchase document's lines had no defined order. Postgres returns rows
 * in whatever order it finds them, so `GET /purchasing/purchases/:id`
 * could hand the same three lines back in a different order on two
 * consecutive reads. The VALUES were always right; only their sequence
 * was arbitrary. That is enough to make a screen reshuffle under a user
 * who did nothing, and enough to make a position-dependent test flake.
 *
 * The sibling collections in the very same query already ordered
 * themselves — receipts by `receivedAt`, returns and payments by their
 * own dates. Only the line collections were missed, so this is that
 * convention finished rather than a new rule.
 *
 * WHY BOTH COLUMNS. `createdAt` alone is NOT a total order here: a
 * purchase's lines are written by one nested `create` inside a single
 * transaction, and Postgres `now()` is transaction-start time, so every
 * line of a purchase carries an IDENTICAL timestamp. `createdAt` is
 * still first because it is the meaningful half — it separates lines
 * added later, when a draft is edited in a subsequent transaction, from
 * the original ones. `id` is the tiebreaker that makes the order total
 * and stable across reads.
 *
 * NO NEW COLUMN, no `lineNumber`, no migration, and no business meaning:
 * this is presentation order over columns that already existed, and it
 * changes no total, no receiving rule and no accounting.
 */
export const DOCUMENT_LINE_ORDER = [{ createdAt: 'asc' }, { id: 'asc' }] satisfies (
  | Prisma.PurchaseItemOrderByWithRelationInput
  | Prisma.PurchaseReceiptItemOrderByWithRelationInput
  | Prisma.PurchaseReturnItemOrderByWithRelationInput
)[];
