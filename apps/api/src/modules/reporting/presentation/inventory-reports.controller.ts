import { Controller, Get, Query } from '@nestjs/common';
import {
  inventoryMovementsQuerySchema,
  inventoryValuationQuerySchema,
  slowMovingQuerySchema,
  InventoryMovementsQuery,
  InventoryValuationQuery,
  SlowMovingQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { InventoryReportsUseCase } from '../application/inventory/inventory-reports.use-case';

@Controller('reports/inventory')
export class InventoryReportsController {
  constructor(private readonly inventory: InventoryReportsUseCase) {}

  @RequirePermissions('reports.inventory.view')
  @Get('valuation')
  async valuation(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(inventoryValuationQuerySchema)) query: InventoryValuationQuery) {
    return this.inventory.valuation(user, query);
  }

  @RequirePermissions('reports.inventory.view')
  @Get('movements')
  async movements(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(inventoryMovementsQuerySchema)) query: InventoryMovementsQuery) {
    return this.inventory.movements(user, query);
  }

  @RequirePermissions('reports.inventory.view')
  @Get('damage-loss')
  async damageAndLoss(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(inventoryMovementsQuerySchema)) query: InventoryMovementsQuery) {
    return this.inventory.damageAndLoss(user, query);
  }

  @RequirePermissions('reports.inventory.view')
  @Get('slow-moving')
  async slowMoving(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(slowMovingQuerySchema)) query: SlowMovingQuery) {
    return this.inventory.slowMoving(user, query);
  }
}
