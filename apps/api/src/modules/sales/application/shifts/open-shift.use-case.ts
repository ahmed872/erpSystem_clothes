import { Injectable } from '@nestjs/common';
import type { OpenShiftInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { findActiveShift } from '../../domain/find-active-shift';

/**
 * Opens a new Shift for the acting user. A Sale cannot be completed
 * without one (see CreateSaleUseCase).
 *
 * Phase 10 (BD-17 rule 2): opening now requires BOTH the cash register
 * being taken over and the cash physically in its drawer. This is a
 * BREAKING CHANGE to the Phase 5 contract - a caller that sends only
 * `warehouseId` now receives 422 - and is reported as such at the release
 * gate rather than absorbed silently.
 *
 * Two independent uniqueness guarantees apply, both enforced by partial
 * unique indexes rather than by the application checks below (which exist
 * only to produce a friendlier message than a raw constraint violation):
 *
 *   shifts_one_open_per_user     (business_id, opened_by)          WHERE OPEN
 *   shifts_one_open_per_register (business_id, cash_register_id)   WHERE OPEN
 *
 * The first is inherited from Phase 5 and is STRICTER than BD-17 rule 10
 * requires: rule 10 forbids one user holding two shifts on the same
 * register, while this forbids a user holding two shifts at all. That
 * pre-existing behaviour is preserved deliberately - loosening it would be
 * a silent change to approved Phase 5 behaviour - and is recorded in the
 * release-gate report.
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

      const register = await tx.cashRegister.findFirst({
        where: { id: input.cashRegisterId, businessId: actor.tenantId },
      });
      if (!register) throw new NotFoundDomainError('CashRegister', input.cashRegisterId);
      if (!register.isActive) {
        throw new ValidationFailedError('This cash register has been deactivated', { cashRegisterId: register.id });
      }
      // A till belongs to a branch, and a shift sells out of a warehouse.
      // Letting the two disagree would put a sale's branch and its drawer
      // in different places, so the pairing is checked rather than assumed.
      if (register.branchId !== warehouse.branchId) {
        throw new ValidationFailedError('This cash register belongs to a different branch than the selected warehouse', {
          cashRegisterId: register.id,
          registerBranchId: register.branchId,
          warehouseBranchId: warehouse.branchId,
        });
      }

      const existing = await findActiveShift(tx, actor.tenantId, actor.id);
      if (existing) {
        throw new ConflictDomainError('You already have an open shift - close it before opening another', { shiftId: existing.id });
      }

      const registerBusy = await tx.shift.findFirst({
        where: { businessId: actor.tenantId, cashRegisterId: register.id, status: 'OPEN' },
        select: { id: true, openedBy: true },
      });
      if (registerBusy) {
        throw new ConflictDomainError('This cash register already has an open shift', {
          cashRegisterId: register.id,
          shiftId: registerBusy.id,
        });
      }

      const shift = await tx.shift.create({
        data: {
          businessId: actor.tenantId,
          branchId: warehouse.branchId,
          warehouseId: input.warehouseId,
          cashRegisterId: register.id,
          openingFloat: input.openingFloat,
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
