import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class GetPromotionUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, id: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const promotion = await tx.promotion.findFirst({
        where: { id, businessId: actor.tenantId },
        include: { _count: { select: { applications: true } } },
      });
      if (!promotion) throw new NotFoundDomainError('Promotion', id);

      return {
        ...promotion,
        // How many historical sale lines this rule has already reduced.
        // Read-only provenance; those rows can never be rewritten.
        applicationCount: promotion._count.applications,
      };
    });
  }
}
