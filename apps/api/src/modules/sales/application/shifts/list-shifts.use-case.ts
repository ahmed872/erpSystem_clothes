import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { computeShiftCash, applyExpectedCashVisibility } from '../../../finance/domain/shift-cash';

/**
 * Shift history with each shift's cash position.
 *
 * Same blind-close stripping as the active-shift endpoint (BD-17 rule 4):
 * a caller without `shifts.view_expected` never receives the expected
 * figure or the variance, on any row. This is the list a manager uses to
 * find shifts still needing reconciliation.
 */
@Injectable()
export class ListShiftsUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const shifts = await tx.shift.findMany({
        where: { businessId: actor.tenantId },
        orderBy: { openedAt: 'desc' },
        take: 200,
      });

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const canViewExpected = permissions?.has('shifts.view_expected') ?? false;

      const data = [];
      for (const shift of shifts) {
        const cash = await computeShiftCash(tx, actor.tenantId, shift);
        data.push(
          applyExpectedCashVisibility(
            {
              ...shift,
              openingFloat: shift.openingFloat.toString(),
              countedCash: shift.countedCash?.toString() ?? null,
              cashIn: cash.cashIn.toString(),
              cashOut: cash.cashOut.toString(),
              expectedCash: cash.expectedCash.toString(),
              variance: cash.variance?.toString() ?? null,
            },
            canViewExpected,
          ),
        );
      }

      return { data };
    });
  }
}
