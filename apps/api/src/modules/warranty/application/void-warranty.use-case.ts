import { Injectable } from '@nestjs/common';
import type { VoidWarrantyInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

/**
 * Voids a warranty (e.g. it was registered against the wrong serial unit,
 * or the sale it covers was returned). VOID is a terminal state: a voided
 * warranty covers nothing and cannot be claimed against.
 *
 * A transition path exists deliberately - a status value the schema
 * declares but no code path can ever set would be a dead enum member
 * masquerading as behaviour (the Phase 7 `STOCK_COUNT` lesson).
 *
 * Record-keeping only, exactly like the rest of Phase 8A: this use-case
 * injects neither InventoryEngineService nor AccountingEngineService, so
 * voiding a warranty structurally cannot move stock, reverse a sale, or
 * post a journal entry. Nothing about the underlying Sale, SaleItem,
 * SerialNumber or inventory changes.
 *
 * History is preserved, never erased: the snapshotted
 * `startDate`/`endDate`/`durationDays` and every existing claim remain
 * exactly as recorded. Only `status` moves.
 */
@Injectable()
export class VoidWarrantyUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, id: string, input: VoidWarrantyInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const warranty = await tx.warranty.findFirst({ where: { id, businessId: actor.tenantId } });
      if (!warranty) throw new NotFoundDomainError('Warranty', id);

      if (warranty.status === 'VOID') {
        throw new ConflictDomainError('This warranty is already voided', { warrantyId: id });
      }

      // Conditional UPDATE rather than read-then-write so two concurrent
      // voids cannot both report success.
      const result = await tx.warranty.updateMany({
        where: { id, businessId: actor.tenantId, status: { not: 'VOID' } },
        data: { status: 'VOID', notes: input.reason ?? warranty.notes },
      });
      if (result.count === 0) {
        throw new ConflictDomainError('This warranty was voided concurrently by someone else', { warrantyId: id });
      }

      const updated = await tx.warranty.findUniqueOrThrow({ where: { id } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Warranty',
        entityId: id,
        before: { status: warranty.status },
        after: { status: updated.status },
        reason: input.reason ?? 'Warranty voided',
      });

      return updated;
    });
  }
}
