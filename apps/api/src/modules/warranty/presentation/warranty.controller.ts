import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  registerWarrantySchema,
  registerWarrantyClaimSchema,
  resolveWarrantyClaimSchema,
  voidWarrantySchema,
  warrantyListQuerySchema,
  RegisterWarrantyInput,
  RegisterWarrantyClaimInput,
  ResolveWarrantyClaimInput,
  VoidWarrantyInput,
  WarrantyListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { RegisterWarrantyUseCase } from '../application/register-warranty.use-case';
import { ListWarrantiesUseCase } from '../application/list-warranties.use-case';
import { GetWarrantyUseCase } from '../application/get-warranty.use-case';
import { VoidWarrantyUseCase } from '../application/void-warranty.use-case';
import { RegisterWarrantyClaimUseCase } from '../application/register-warranty-claim.use-case';
import { ListWarrantyClaimsUseCase } from '../application/list-warranty-claims.use-case';
import { ResolveWarrantyClaimUseCase } from '../application/resolve-warranty-claim.use-case';

/**
 * Every route carries an explicit @RequirePermissions - authorization is
 * server-side and there is no route reachable on authentication alone.
 * Claim routes are nested under their warranty so the parent is always
 * resolved inside the caller's tenant before a claim is touched.
 */
@Controller('warranties')
export class WarrantyController {
  constructor(
    private readonly registerWarranty: RegisterWarrantyUseCase,
    private readonly listWarranties: ListWarrantiesUseCase,
    private readonly getWarranty: GetWarrantyUseCase,
    private readonly voidWarranty: VoidWarrantyUseCase,
    private readonly registerClaim: RegisterWarrantyClaimUseCase,
    private readonly listClaims: ListWarrantyClaimsUseCase,
    private readonly resolveClaim: ResolveWarrantyClaimUseCase,
  ) {}

  @RequirePermissions('warranty.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(warrantyListQuerySchema)) query: WarrantyListQuery) {
    return this.listWarranties.execute(user, query);
  }

  @RequirePermissions('warranty.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getWarranty.execute(user, id) };
  }

  @RequirePermissions('warranty.register')
  @Post()
  async register(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(registerWarrantySchema)) body: RegisterWarrantyInput) {
    return { data: await this.registerWarranty.execute(user, body) };
  }

  @RequirePermissions('warranty.register')
  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  async void(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ZodValidationPipe(voidWarrantySchema)) body: VoidWarrantyInput) {
    return { data: await this.voidWarranty.execute(user, id, body) };
  }

  @RequirePermissions('warranty.view')
  @Get(':id/claims')
  async claims(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.listClaims.execute(user, id);
  }

  @RequirePermissions('warranty.claim')
  @Post(':id/claims')
  async claim(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(registerWarrantyClaimSchema)) body: RegisterWarrantyClaimInput,
  ) {
    return { data: await this.registerClaim.execute(user, id, body) };
  }

  @RequirePermissions('warranty.claim')
  @Post(':id/claims/:claimId/resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('claimId') claimId: string,
    @Body(new ZodValidationPipe(resolveWarrantyClaimSchema)) body: ResolveWarrantyClaimInput,
  ) {
    return { data: await this.resolveClaim.execute(user, id, claimId, body) };
  }
}
