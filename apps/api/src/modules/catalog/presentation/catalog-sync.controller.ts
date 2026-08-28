import { Controller, Get, Query } from '@nestjs/common';
import { catalogSyncQuerySchema, CatalogSyncQuery } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CatalogSyncService } from '../application/catalog-sync.service';

@Controller('catalog/sync')
export class CatalogSyncController {
  constructor(private readonly sync: CatalogSyncService) {}

  @RequirePermissions('products.view')
  @Get()
  async getSync(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(catalogSyncQuerySchema)) query: CatalogSyncQuery) {
    return this.sync.sync(user, query);
  }
}
