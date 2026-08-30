import { Module } from '@nestjs/common';
import { PromotionsController } from './presentation/promotions.controller';
import { CreatePromotionUseCase } from './application/create-promotion.use-case';
import { UpdatePromotionUseCase } from './application/update-promotion.use-case';
import { DeactivatePromotionUseCase } from './application/deactivate-promotion.use-case';
import { ListPromotionsUseCase } from './application/list-promotions.use-case';
import { GetPromotionUseCase } from './application/get-promotion.use-case';

/**
 * Phase 8D - Promotions. Deliberately imports neither
 * InventoryEngineModule nor AccountingEngineModule: a promotion changes
 * only a sale line's discount, so it can move no stock and post no
 * journal entry, and the module graph is what makes that structural
 * rather than a convention. The promotion ENGINE itself is a pure domain
 * module consumed by CreateSaleUseCase, not a provider here.
 */
@Module({
  controllers: [PromotionsController],
  providers: [
    CreatePromotionUseCase,
    UpdatePromotionUseCase,
    DeactivatePromotionUseCase,
    ListPromotionsUseCase,
    GetPromotionUseCase,
  ],
})
export class PromotionsModule {}
