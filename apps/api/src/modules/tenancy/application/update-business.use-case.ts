import { Injectable } from '@nestjs/common';
import type { UpdateBusinessInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class UpdateBusinessUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: UpdateBusinessInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.business.findUnique({ where: { id: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Business', actor.tenantId);

      const after = await tx.business.update({
        where: { id: actor.tenantId },
        // Phase 10 (10F): the profile fields are NULLABLE, so `undefined`
        // (absent) and `null` (explicitly cleared) mean different things
        // and cannot be collapsed with `??` the way the three required
        // fields above can.
        data: {
          name: input.name ?? undefined,
          currency: input.currency ?? undefined,
          timezone: input.timezone ?? undefined,
          legalName: input.legalName,
          taxNumber: input.taxNumber,
          registrationNumber: input.registrationNumber,
          phone: input.phone,
          email: input.email,
          addressLine: input.addressLine,
          city: input.city,
          country: input.country,
          logoUrl: input.logoUrl,
          receiptHeader: input.receiptHeader,
          receiptFooter: input.receiptFooter,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Business',
        entityId: actor.tenantId,
        before,
        after,
      });

      return after;
    });
  }
}
