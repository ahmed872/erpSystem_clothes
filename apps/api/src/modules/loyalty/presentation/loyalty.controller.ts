import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  adjustCustomerPointsSchema,
  customerPointsListQuerySchema,
  AdjustCustomerPointsInput,
  CustomerPointsListQuery,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { GetCustomerPointsUseCase } from '../application/get-customer-points.use-case';
import { ListCustomerPointsUseCase } from '../application/list-customer-points.use-case';
import { AdjustCustomerPointsUseCase } from '../application/adjust-customer-points.use-case';

/**
 * Loyalty routes hang off the customer they belong to, matching the
 * approved API design. Every route carries an explicit
 * @RequirePermissions; reading a balance and adjusting one are separate
 * permissions because they are very different acts.
 */
@Controller('sales/customers/:customerId/points')
export class LoyaltyController {
  constructor(
    private readonly getPoints: GetCustomerPointsUseCase,
    private readonly listPoints: ListCustomerPointsUseCase,
    private readonly adjustPoints: AdjustCustomerPointsUseCase,
  ) {}

  @RequirePermissions('loyalty.view')
  @Get()
  async get(@CurrentUser() user: RequestUser, @Param('customerId') customerId: string) {
    return { data: await this.getPoints.execute(user, customerId) };
  }

  @RequirePermissions('loyalty.view')
  @Get('ledger')
  async ledger(
    @CurrentUser() user: RequestUser,
    @Param('customerId') customerId: string,
    @Query(new ZodValidationPipe(customerPointsListQuerySchema)) query: CustomerPointsListQuery,
  ) {
    return this.listPoints.execute(user, customerId, query);
  }

  @RequirePermissions('loyalty.adjust')
  @Post('adjust')
  async adjust(
    @CurrentUser() user: RequestUser,
    @Param('customerId') customerId: string,
    @Body(new ZodValidationPipe(adjustCustomerPointsSchema)) body: AdjustCustomerPointsInput,
  ) {
    return { data: await this.adjustPoints.execute(user, customerId, body) };
  }
}
