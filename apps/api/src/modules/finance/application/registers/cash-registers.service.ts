import { Injectable } from '@nestjs/common';
import type { CreateCashRegisterInput, UpdateCashRegisterInput, ListCashRegistersQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Phase 10 (BD-17) — cash register configuration.
 *
 * A register is a physical till belonging to a branch. This is
 * configuration only: creating or renaming one moves no money, touches no
 * shift, and posts nothing. The design is deliberately generic across the
 * whole product range - one register in a small shop, several in a branch,
 * many across branches - because the Retail Operating System is not
 * targeted at any one size of business.
 *
 * Registers are never hard-deleted. `isActive = false` retires one, so a
 * register that once hosted a shift stays resolvable forever and the
 * historical shift record keeps its meaning. The grant deliberately
 * withholds DELETE to make that structural rather than conventional.
 */
@Injectable()
export class CashRegistersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: RequestUser, input: CreateCashRegisterInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, businessId: actor.tenantId } });
      if (!branch) throw new NotFoundDomainError('Branch', input.branchId);

      const register = await tx.cashRegister.create({
        data: {
          businessId: actor.tenantId,
          branchId: input.branchId,
          name: input.name,
          code: input.code,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'CashRegister',
        entityId: register.id,
        after: register,
      });

      return register;
    });
  }

  async update(actor: RequestUser, id: string, input: UpdateCashRegisterInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.cashRegister.findFirst({ where: { id, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('CashRegister', id);

      // Retiring a register with a shift still open on it would strand
      // that shift: it could never be closed against an inactive till, and
      // the one-open-shift-per-register index would keep blocking the next
      // one. Rejected explicitly rather than left to surprise someone.
      if (input.isActive === false) {
        const openShift = await tx.shift.findFirst({
          where: { businessId: actor.tenantId, cashRegisterId: id, status: 'OPEN' },
          select: { id: true },
        });
        if (openShift) {
          throw new ValidationFailedError('This register has an open shift - close it before deactivating the register', {
            shiftId: openShift.id,
          });
        }
      }

      const after = await tx.cashRegister.update({
        where: { id },
        data: {
          name: input.name,
          code: input.code,
          isActive: input.isActive,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'CashRegister',
        entityId: id,
        before,
        after,
      });

      return after;
    });
  }

  async list(actor: RequestUser, query: ListCashRegistersQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) =>
      tx.cashRegister.findMany({
        where: {
          businessId: actor.tenantId,
          ...(query.branchId ? { branchId: query.branchId } : {}),
          ...(query.includeInactive ? {} : { isActive: true }),
        },
        orderBy: [{ branchId: 'asc' }, { code: 'asc' }],
      }),
    );
  }
}
