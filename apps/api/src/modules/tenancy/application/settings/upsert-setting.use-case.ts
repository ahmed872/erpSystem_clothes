import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { UpsertSettingInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class UpsertSettingUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: UpsertSettingInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.setting.findUnique({
        where: { businessId_key: { businessId: actor.tenantId, key: input.key } },
      });

      const after = await tx.setting.upsert({
        where: { businessId_key: { businessId: actor.tenantId, key: input.key } },
        create: {
          businessId: actor.tenantId,
          key: input.key,
          value: input.value as Prisma.InputJsonValue,
          updatedBy: actor.id,
        },
        update: { value: input.value as Prisma.InputJsonValue, updatedBy: actor.id },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: before ? 'UPDATE' : 'CREATE',
        entityType: 'Setting',
        entityId: after.id,
        before,
        after,
      });

      return after;
    });
  }
}
