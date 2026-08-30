import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createPromotionSchema,
  updatePromotionSchema,
  promotionListQuerySchema,
  CreatePromotionInput,
  UpdatePromotionInput,
  PromotionListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreatePromotionUseCase } from '../application/create-promotion.use-case';
import { UpdatePromotionUseCase } from '../application/update-promotion.use-case';
import { DeactivatePromotionUseCase } from '../application/deactivate-promotion.use-case';
import { ListPromotionsUseCase } from '../application/list-promotions.use-case';
import { GetPromotionUseCase } from '../application/get-promotion.use-case';

/**
 * Promotion CONFIGURATION only. There is deliberately no route that
 * applies a promotion to a sale - application happens server-side inside
 * CreateSaleUseCase's transaction, so a client can never supply
 * promotional pricing (approved policy).
 *
 * Every route carries an explicit @RequirePermissions. Authoring a
 * discount rule is a pricing decision, so create/edit/deactivate are
 * Owner-only by default while every POS-facing role can view.
 */
@Controller('promotions')
export class PromotionsController {
  constructor(
    private readonly createPromotion: CreatePromotionUseCase,
    private readonly updatePromotion: UpdatePromotionUseCase,
    private readonly deactivatePromotion: DeactivatePromotionUseCase,
    private readonly listPromotions: ListPromotionsUseCase,
    private readonly getPromotion: GetPromotionUseCase,
  ) {}

  @RequirePermissions('promotions.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(promotionListQuerySchema)) query: PromotionListQuery) {
    return this.listPromotions.execute(user, query);
  }

  @RequirePermissions('promotions.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.getPromotion.execute(user, id) };
  }

  @RequirePermissions('promotions.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createPromotionSchema)) body: CreatePromotionInput) {
    return { data: await this.createPromotion.execute(user, body) };
  }

  @RequirePermissions('promotions.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePromotionSchema)) body: UpdatePromotionInput,
  ) {
    return { data: await this.updatePromotion.execute(user, id, body) };
  }

  @RequirePermissions('promotions.deactivate')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deactivate(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.deactivatePromotion.execute(user, id) };
  }
}
