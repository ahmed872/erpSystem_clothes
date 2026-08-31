import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { ValidationFailedError } from '../../../../common/errors/domain-error';

export interface PosWarehouseOption {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
  isDefault: boolean;
}

/**
 * Phase 12 BLOCKING-B. `POST /sales/shifts/open` requires a `warehouseId`
 * the caller must already know, but `GET /warehouses` is gated on
 * `warehouses.view` - a permission NONE of the POS-selling role templates
 * (Cashier, Sales Employee) hold, and one this fix deliberately does not
 * grant them (that would be an administrative capability handed out purely
 * to solve UI discovery). This is the narrow POS-safe alternative: it
 * answers "which warehouse(s) may I, the authenticated caller, open a
 * shift against" and nothing more.
 *
 * Gated on `shifts.open` at the controller (the same permission that
 * actually consumes the `warehouseId` this endpoint returns) - a role that
 * cannot open a shift gets a plain 403 like any other endpoint, rather
 * than a populated list implying sales access it does not have. No new
 * permission is introduced.
 *
 * Scope resolution reuses the existing role/permission model rather than
 * inventing one:
 *   - A caller who already holds `warehouses.view` (e.g. the Business
 *     Owner) is business-wide by that EXISTING grant, so this returns
 *     every active warehouse tenant-wide - identical to what `GET
 *     /warehouses` would show them. Nothing is restricted that wasn't
 *     already open to them.
 *   - Everyone else is scoped to `UserBranch` - the same "which branches is
 *     this user assigned to" fact `resolveBranchScope` (Phase 7 reporting)
 *     already uses, applied here to warehouses instead of reports. A
 *     caller with NO UserBranch rows gets NOTHING (fail closed), never
 *     "every warehouse" - the whole point of this contract is that a till
 *     user never sees an unrelated warehouse.
 *
 * An empty result - no assigned branch, or an assigned branch with no
 * active warehouse - is a clear business error (422), not a silent empty
 * list a frontend would have to interpret; this is also what makes "first
 * morning, no sales/inventory history yet" safe: the answer comes from
 * `UserBranch`/`Warehouse.isActive`, never from any transactional table.
 */
@Injectable()
export class ListPosWarehousesUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser): Promise<PosWarehouseOption[]> {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const granted = await this.effectivePermissions.get(tx, actor.id);
      const unrestricted = granted?.has('warehouses.view') ?? false;

      let branchIds: string[] | null = null;
      if (!unrestricted) {
        const rows = await tx.userBranch.findMany({ where: { userId: actor.id }, select: { branchId: true } });
        branchIds = rows.map((r) => r.branchId);
        if (branchIds.length === 0) {
          throw new ValidationFailedError(
            'No branch is assigned to your account, so no warehouse is available for sales. Ask an administrator to assign you to a branch.',
          );
        }
      }

      const warehouses = await tx.warehouse.findMany({
        where: {
          businessId: actor.tenantId,
          isActive: true,
          ...(branchIds ? { branchId: { in: branchIds } } : {}),
        },
        select: { id: true, name: true, isDefault: true, branchId: true, branch: { select: { name: true } } },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      });

      if (warehouses.length === 0) {
        throw new ValidationFailedError(
          'No active warehouse is available for sales in your assigned branch(es). Ask an administrator to configure one.',
        );
      }

      return warehouses.map((w) => ({
        id: w.id,
        name: w.name,
        branchId: w.branchId,
        branchName: w.branch.name,
        isDefault: w.isDefault,
      }));
    });
  }
}
