import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { findActiveShift } from '../../domain/find-active-shift';
import { computeShiftCash, applyExpectedCashVisibility } from '../../../finance/domain/shift-cash';

/**
 * The caller's own open shift, with its live cash position.
 *
 * Phase 10 (BD-17 rule 4): this is THE endpoint a till would poll, and so
 * it is the one that would break blind close if it leaked. The expected
 * figure, the variance and the in/out totals that trivially reveal them are
 * REMOVED from the response for any caller lacking `shifts.view_expected`
 * — not nulled, not left for the screen to hide. A cashier's device never
 * receives the number, so no amount of tampering with the client surfaces
 * it. `openingFloat` is not stripped: the cashier keyed it in themselves.
 */
@Injectable()
export class GetActiveShiftUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const shift = await findActiveShift(tx, actor.tenantId, actor.id);
      if (!shift) return null;

      const cash = await computeShiftCash(tx, actor.tenantId, shift);
      const permissions = await this.effectivePermissions.get(tx, actor.id);

      return applyExpectedCashVisibility(
        {
          ...shift,
          openingFloat: shift.openingFloat.toString(),
          countedCash: shift.countedCash?.toString() ?? null,
          cashIn: cash.cashIn.toString(),
          cashOut: cash.cashOut.toString(),
          expectedCash: cash.expectedCash.toString(),
          variance: cash.variance?.toString() ?? null,
        },
        permissions?.has('shifts.view_expected') ?? false,
      );
    });
  }
}
