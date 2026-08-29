import { Controller, Get, Query } from '@nestjs/common';
import { reportRangeQuerySchema, reconciliationQuerySchema, ReportRangeQuery, ReconciliationQuery } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { DashboardUseCase } from '../application/dashboard/dashboard.use-case';
import { ReconciliationUseCase } from '../application/reconciliation/reconciliation.use-case';

@Controller('reports')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardUseCase,
    private readonly reconciliation: ReconciliationUseCase,
  ) {}

  @RequirePermissions('reports.dashboard.view')
  @Get('dashboard')
  async getDashboard(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(reportRangeQuerySchema)) query: ReportRangeQuery) {
    return this.dashboard.execute(user, query);
  }

  @RequirePermissions('reports.inventory.view')
  @Get('reconciliation/inventory-ledger')
  async inventoryLedger(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(reconciliationQuerySchema)) query: ReconciliationQuery) {
    return this.reconciliation.inventoryLedger(user, query);
  }

  @RequirePermissions('reports.financial.view')
  @Get('reconciliation/customer-ar')
  async customerAr(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(reconciliationQuerySchema)) query: ReconciliationQuery) {
    return this.reconciliation.customerAr(user, query);
  }

  @RequirePermissions('reports.financial.view')
  @Get('reconciliation/supplier-ap')
  async supplierAp(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(reconciliationQuerySchema)) query: ReconciliationQuery) {
    return this.reconciliation.supplierAp(user, query);
  }

  @RequirePermissions('reports.financial.view')
  @Get('reconciliation/inventory-gl')
  async inventoryGl(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(reconciliationQuerySchema)) query: ReconciliationQuery) {
    return this.reconciliation.inventoryGl(user, query);
  }
}
