import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { registerBusinessSchema, updateBusinessSchema, UpdateBusinessInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { Public } from '../../../common/decorators/public.decorator';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { RegisterBusinessUseCase } from '../application/register-business.use-case';
import { GetBusinessUseCase } from '../application/get-business.use-case';
import { UpdateBusinessUseCase } from '../application/update-business.use-case';

@Controller()
export class BusinessController {
  constructor(
    private readonly registerBusiness: RegisterBusinessUseCase,
    private readonly getBusiness: GetBusinessUseCase,
    private readonly updateBusiness: UpdateBusinessUseCase,
  ) {}

  @Public()
  @Post('businesses/register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body(new ZodValidationPipe(registerBusinessSchema)) body: ReturnType<typeof registerBusinessSchema.parse>) {
    const result = await this.registerBusiness.execute(body);
    return { data: result };
  }

  @RequirePermissions('business.view')
  @Get('business')
  async get(@CurrentUser() user: RequestUser) {
    const business = await this.getBusiness.execute(user.tenantId);
    return { data: business };
  }

  @RequirePermissions('business.edit')
  @Patch('business')
  async update(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(updateBusinessSchema)) body: UpdateBusinessInput,
  ) {
    const business = await this.updateBusiness.execute(user, body);
    return { data: business };
  }
}
