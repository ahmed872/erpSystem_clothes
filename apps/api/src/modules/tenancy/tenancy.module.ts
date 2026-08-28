import { Module } from '@nestjs/common';
import { PasswordHasherService } from '../../common/security/password-hasher.service';
import { BusinessController } from './presentation/business.controller';
import { BranchesController } from './presentation/branches.controller';
import { WarehousesController } from './presentation/warehouses.controller';
import { SettingsController } from './presentation/settings.controller';
import { RegisterBusinessUseCase } from './application/register-business.use-case';
import { GetBusinessUseCase } from './application/get-business.use-case';
import { UpdateBusinessUseCase } from './application/update-business.use-case';
import { CreateBranchUseCase } from './application/branches/create-branch.use-case';
import { ListBranchesUseCase } from './application/branches/list-branches.use-case';
import { UpdateBranchUseCase } from './application/branches/update-branch.use-case';
import { CreateWarehouseUseCase } from './application/warehouses/create-warehouse.use-case';
import { ListWarehousesUseCase } from './application/warehouses/list-warehouses.use-case';
import { UpdateWarehouseUseCase } from './application/warehouses/update-warehouse.use-case';
import { ListSettingsUseCase } from './application/settings/list-settings.use-case';
import { UpsertSettingUseCase } from './application/settings/upsert-setting.use-case';

@Module({
  controllers: [BusinessController, BranchesController, WarehousesController, SettingsController],
  providers: [
    PasswordHasherService,
    RegisterBusinessUseCase,
    GetBusinessUseCase,
    UpdateBusinessUseCase,
    CreateBranchUseCase,
    ListBranchesUseCase,
    UpdateBranchUseCase,
    CreateWarehouseUseCase,
    ListWarehousesUseCase,
    UpdateWarehouseUseCase,
    ListSettingsUseCase,
    UpsertSettingUseCase,
  ],
})
export class TenancyModule {}
