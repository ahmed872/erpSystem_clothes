import { Module } from '@nestjs/common';
import { LoyaltyController } from './presentation/loyalty.controller';
import { GetCustomerPointsUseCase } from './application/get-customer-points.use-case';
import { ListCustomerPointsUseCase } from './application/list-customer-points.use-case';
import { AdjustCustomerPointsUseCase } from './application/adjust-customer-points.use-case';

/**
 * Phase 8B - Loyalty Ledger. Deliberately imports neither
 * InventoryEngineModule nor AccountingEngineModule: the approved policy
 * states loyalty points are NOT a General Ledger liability in Phase 8,
 * and the module graph is what makes that structural rather than a
 * convention - no code path here can reach postEntry.
 */
@Module({
  controllers: [LoyaltyController],
  providers: [GetCustomerPointsUseCase, ListCustomerPointsUseCase, AdjustCustomerPointsUseCase],
})
export class LoyaltyModule {}
