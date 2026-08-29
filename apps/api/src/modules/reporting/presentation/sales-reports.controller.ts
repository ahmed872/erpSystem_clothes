import { Controller, Get, Query } from '@nestjs/common';
import {
  reportRangeQuerySchema,
  reportListQuerySchema,
  salesByDimensionQuerySchema,
  ReportRangeQuery,
  ReportListQuery,
  SalesByDimensionQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { SalesSummaryUseCase } from '../application/sales/sales-summary.use-case';
import { SalesByDimensionUseCase } from '../application/sales/sales-by-dimension.use-case';
import { SalesReturnsReportUseCase } from '../application/sales/sales-returns-report.use-case';
import { PurchasingReportUseCase } from '../application/sales/purchasing-report.use-case';

@Controller('reports')
export class SalesReportsController {
  constructor(
    private readonly salesSummary: SalesSummaryUseCase,
    private readonly salesByDimension: SalesByDimensionUseCase,
    private readonly salesReturns: SalesReturnsReportUseCase,
    private readonly purchasing: PurchasingReportUseCase,
  ) {}

  @RequirePermissions('reports.sales.view')
  @Get('sales/summary')
  async summary(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(reportRangeQuerySchema)) query: ReportRangeQuery) {
    return this.salesSummary.execute(user, query);
  }

  @RequirePermissions('reports.sales.view')
  @Get('sales/by-product')
  async byProduct(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(salesByDimensionQuerySchema)) query: SalesByDimensionQuery) {
    return this.salesByDimension.execute(user, 'product', query);
  }

  @RequirePermissions('reports.sales.view')
  @Get('sales/by-category')
  async byCategory(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(salesByDimensionQuerySchema)) query: SalesByDimensionQuery) {
    return this.salesByDimension.execute(user, 'category', query);
  }

  @RequirePermissions('reports.sales.view')
  @Get('sales/by-branch')
  async byBranch(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(salesByDimensionQuerySchema)) query: SalesByDimensionQuery) {
    return this.salesByDimension.execute(user, 'branch', query);
  }

  @RequirePermissions('reports.sales.view')
  @Get('sales/by-user')
  async byUser(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(salesByDimensionQuerySchema)) query: SalesByDimensionQuery) {
    return this.salesByDimension.execute(user, 'user', query);
  }

  @RequirePermissions('reports.sales.view')
  @Get('sales/by-payment-method')
  async byPaymentMethod(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(salesByDimensionQuerySchema)) query: SalesByDimensionQuery) {
    return this.salesByDimension.execute(user, 'paymentMethod', query);
  }

  @RequirePermissions('reports.sales.view')
  @Get('sales/returns')
  async returns(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(reportListQuerySchema)) query: ReportListQuery) {
    return this.salesReturns.execute(user, query);
  }

  @RequirePermissions('reports.sales.view')
  @Get('purchasing/summary')
  async purchasingSummary(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(reportListQuerySchema)) query: ReportListQuery) {
    return this.purchasing.execute(user, query);
  }
}
