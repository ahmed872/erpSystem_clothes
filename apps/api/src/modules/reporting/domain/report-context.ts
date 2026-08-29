import { TenantTx } from '../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../common/authorization/effective-permissions.service';
import { ForbiddenDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { BranchScope, resolveBranchScope } from './branch-scope';
import { ResolvedDateRange, resolveDateRange } from './date-range';
import { ReportVisibility, resolveVisibility } from './report-visibility';

export interface ReportContext {
  businessId: string;
  userId: string;
  permissions: Set<string>;
  branchScope: BranchScope;
  visibility: ReportVisibility;
  range: ResolvedDateRange;
}

/**
 * Resolves the three things EVERY report needs before it may read a
 * single row: which branches this caller may see, which cost/profit
 * fields they may see, and the exact date window (in the business's own
 * timezone). Centralised deliberately - a report that forgot any one of
 * these would be a security or correctness bug, so they are resolved
 * together, once, and handed to the use-case as a single required object
 * rather than assembled ad hoc per report.
 *
 * Route-level permission is already enforced by PermissionsGuard before
 * this runs; the permission set is re-read here for FIELD-level decisions
 * (defence in depth - the same reason GetSaleUseCase re-reads it in
 * Phase 5 rather than trusting the guard alone).
 */
export async function resolveReportContext(
  tx: TenantTx,
  effectivePermissions: EffectivePermissionsService,
  actor: RequestUser,
  query: { from?: Date; to?: Date; branchId?: string },
): Promise<ReportContext> {
  const permissions = await effectivePermissions.get(tx, actor.id);
  if (!permissions) throw new ForbiddenDomainError('Insufficient permissions');

  const branchScope = await resolveBranchScope(tx, actor.tenantId, actor.id, permissions, query.branchId);
  const range = await resolveDateRange(tx, actor.tenantId, query.from, query.to);

  return {
    businessId: actor.tenantId,
    userId: actor.id,
    permissions,
    branchScope,
    visibility: resolveVisibility(permissions),
    range,
  };
}
