import { Module } from '@nestjs/common';
import { SalesReportsController } from './presentation/sales-reports.controller';
import { SalesSummaryUseCase } from './application/sales/sales-summary.use-case';
import { SalesByDimensionUseCase } from './application/sales/sales-by-dimension.use-case';
import { SalesReturnsReportUseCase } from './application/sales/sales-returns-report.use-case';
import { PurchasingReportUseCase } from './application/sales/purchasing-report.use-case';
import { InventoryReportsController } from './presentation/inventory-reports.controller';
import { InventoryReportsUseCase } from './application/inventory/inventory-reports.use-case';

/**
 * Phase 7: a strictly READ-ONLY reporting layer over the source-of-truth
 * systems built in Phases 3-6. This module contains no mutation of any
 * kind - no use-case here writes to sales, purchases, stock_movements,
 * stock_balances, customer_transactions, supplier_transactions,
 * journal_entries or journal_entry_lines, and Phase 7 introduces no
 * reporting tables (no duplicate source of truth). It needs no new
 * `erp_app` grants: it reads tables the runtime role already has SELECT
 * on, through the same RLS-enforced `withTenant` transactions as every
 * other module.
 */
@Module({
  controllers: [SalesReportsController, InventoryReportsController],
  providers: [SalesSummaryUseCase, SalesByDimensionUseCase, SalesReturnsReportUseCase, PurchasingReportUseCase, InventoryReportsUseCase],
})
export class ReportingModule {}
