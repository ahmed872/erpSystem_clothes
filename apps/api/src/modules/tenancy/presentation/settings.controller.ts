import { Body, Controller, Get, Put } from '@nestjs/common';
import { upsertSettingSchema, UpsertSettingInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { ListSettingsUseCase } from '../application/settings/list-settings.use-case';
import { UpsertSettingUseCase } from '../application/settings/upsert-setting.use-case';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly listSettings: ListSettingsUseCase,
    private readonly upsertSetting: UpsertSettingUseCase,
  ) {}

  @RequirePermissions('settings.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.listSettings.execute(user) };
  }

  @RequirePermissions('settings.edit')
  @Put()
  async upsert(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(upsertSettingSchema)) body: UpsertSettingInput,
  ) {
    return { data: await this.upsertSetting.execute(user, body) };
  }
}
