import { TenantTx } from '../../../common/prisma/prisma.service';
import { ForbiddenDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';

/**
 * Resolves which branches a caller is allowed to see reporting data for,
 * and validates any client-supplied `branchId` against that set.
 *
 * This is the FIRST branch-level authorization in the system (Phase 7
 * scope decision, approved): `UserBranch` has existed since Phase 1 but
 * was only ever used for user CRUD - no read endpoint enforced it. The
 * rule adopted here, deliberately narrow so it cannot silently change
 * behaviour for existing roles:
 *
 *   - A caller holding a business-wide reporting role (one that can see
 *     financial statements, i.e. `reports.financial.view`) is NOT branch
 *     restricted - the Owner/Accountant read the whole business by
 *     design, and a Balance Sheet for one branch is meaningless when the
 *     Chart of Accounts is business-scoped (Phase 6 decision).
 *   - Any other reporting caller (today: BRANCH_MANAGER) is restricted to
 *     the branches in their own `UserBranch` rows.
 *   - A restricted caller with NO UserBranch rows sees nothing at all
 *     (an empty allow-list), never "everything" - fail closed, never open.
 *
 * Returns `null` to mean "unrestricted" (no branch predicate is added to
 * the query); returns a non-empty array to mean "restrict to exactly
 * these branch ids". Callers MUST apply the returned value to EVERY
 * query, including aggregates - see the reporting use-cases, which take
 * it as a required argument rather than an optional filter so it cannot
 * be forgotten.
 *
 * Passing a `branchId` the caller is not entitled to is a 403, never a
 * silent empty result - a silent empty result would let a client probe
 * which branches exist by observing response shape.
 */
export interface BranchScope {
  /** null = unrestricted; array = restrict to exactly these ids. */
  allowedBranchIds: string[] | null;
  /** The single branch the caller explicitly asked to filter on, if any. */
  requestedBranchId?: string;
}

export async function resolveBranchScope(
  tx: TenantTx,
  businessId: string,
  userId: string,
  permissions: Set<string>,
  requestedBranchId?: string,
): Promise<BranchScope> {
  const unrestricted = permissions.has('reports.financial.view');

  let allowedBranchIds: string[] | null = null;
  if (!unrestricted) {
    const rows = await tx.userBranch.findMany({ where: { userId }, select: { branchId: true } });
    // Fail closed: no assignment means no branches, never all branches.
    allowedBranchIds = rows.map((r) => r.branchId);
  }

  if (requestedBranchId) {
    const branch = await tx.branch.findFirst({ where: { id: requestedBranchId, businessId } });
    if (!branch) throw new NotFoundDomainError('Branch', requestedBranchId);
    if (allowedBranchIds !== null && !allowedBranchIds.includes(requestedBranchId)) {
      throw new ForbiddenDomainError('You are not assigned to this branch');
    }
    // An explicit, authorized request narrows the scope to exactly that branch.
    return { allowedBranchIds: [requestedBranchId], requestedBranchId };
  }

  return { allowedBranchIds };
}

/**
 * The Prisma `where` fragment for a resolved scope. Returns `{}` when
 * unrestricted, so it can be spread into any where-clause unconditionally.
 * Using `{ in: [] }` for an empty allow-list is intentional: it matches
 * zero rows, which is the correct fail-closed behaviour for a restricted
 * user with no branch assignments.
 */
export function branchWhere(scope: BranchScope): { branchId?: { in: string[] } } {
  if (scope.allowedBranchIds === null) return {};
  return { branchId: { in: scope.allowedBranchIds } };
}
