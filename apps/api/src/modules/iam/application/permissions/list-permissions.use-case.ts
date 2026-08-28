import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * The permission catalog is global (not tenant-scoped), so this reads
 * through the plain client rather than `withTenant` - there is no
 * business_id to isolate on, and the table has no RLS policy (see
 * migration 20260828121500_enable_row_level_security). Still requires an
 * authenticated tenant user, enforced by the route guard.
 */
@Injectable()
export class ListPermissionsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(_actor: RequestUser) {
    return this.prisma.client.permission.findMany({ orderBy: { code: 'asc' } });
  }
}
