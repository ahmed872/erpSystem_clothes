import { Injectable } from '@nestjs/common';
import type { OpenShiftInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { findActiveShift } from '../../domain/find-active-shift';

/**
 * Opens a new Shift for the acting user. A Sale cannot be completed
 * without one (see CreateSaleUseCase). The application-level pre-check
 * here is a friendlier error message; the actual guarantee against two
 * concurrent opens racing past this check is the partial unique index
 * `shifts_one_open_per_user` (business_id, opened_by) WHERE status='OPEN'
 * - the database rejects the second INSERT outright, mapped to 409 by
 * AllExceptionsFilter's P2002 handling.
 */
@Injectable()
export class OpenShiftUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: OpenShiftInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, businessId: actor.tenantId } });
      if (!warehouse) throw new NotFoundDomainError('Warehouse', input.warehouseId);

      const existing = await findActiveShift(tx, actor.tenantId, actor.id);
      if (existing) {
        throw new ConflictDomainError('You already have an open shift - close it before opening another', { shiftId: existing.id });
      }

      const shift = await tx.shift.create({
        data: {
          businessId: actor.tenantId,
          branchId: warehouse.branchId,
          warehouseId: input.warehouseId,
          openedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Shift',
        entityId: shift.id,
        after: shift,
      });

      return shift;
    });
  }
}
