import { Module } from '@nestjs/common';
import { WarrantyController } from './presentation/warranty.controller';
import { RegisterWarrantyUseCase } from './application/register-warranty.use-case';
import { ListWarrantiesUseCase } from './application/list-warranties.use-case';
import { GetWarrantyUseCase } from './application/get-warranty.use-case';
import { VoidWarrantyUseCase } from './application/void-warranty.use-case';
import { RegisterWarrantyClaimUseCase } from './application/register-warranty-claim.use-case';
import { ListWarrantyClaimsUseCase } from './application/list-warranty-claims.use-case';
import { ResolveWarrantyClaimUseCase } from './application/resolve-warranty-claim.use-case';

/**
 * Phase 8A - Warranty. Deliberately imports neither InventoryEngineModule
 * nor AccountingEngineModule: warranty is record-keeping only, and the
 * module graph is what makes that structural rather than a convention.
 */
@Module({
  controllers: [WarrantyController],
  providers: [
    RegisterWarrantyUseCase,
    ListWarrantiesUseCase,
    GetWarrantyUseCase,
    VoidWarrantyUseCase,
    RegisterWarrantyClaimUseCase,
    ListWarrantyClaimsUseCase,
    ResolveWarrantyClaimUseCase,
  ],
})
export class WarrantyModule {}
