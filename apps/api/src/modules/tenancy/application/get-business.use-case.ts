import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';

@Injectable()
export class GetBusinessUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(tenantId: string) {
    const business = await this.prisma.withTenant(tenantId, (tx) =>
      tx.business.findUnique({ where: { id: tenantId } }),
    );
    if (!business) throw new NotFoundDomainError('Business', tenantId);
    return business;
  }
}
