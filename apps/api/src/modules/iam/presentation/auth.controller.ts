import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { loginSchema, refreshTokenSchema, LoginInput, RefreshTokenInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { Public } from '../../../common/decorators/public.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { LoginUseCase } from '../application/auth/login.use-case';
import { RefreshTokenUseCase } from '../application/auth/refresh-token.use-case';
import { LogoutUseCase } from '../application/auth/logout.use-case';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly login: LoginUseCase,
    private readonly refresh: RefreshTokenUseCase,
    private readonly logout: LogoutUseCase,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async loginHandler(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput, @Req() req: Request) {
    const result = await this.login.execute(body, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      requestId: (req as Request & { requestId?: string }).requestId ?? null,
    });
    return { data: result };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshHandler(@Body(new ZodValidationPipe(refreshTokenSchema)) body: RefreshTokenInput) {
    const result = await this.refresh.execute(body.refreshToken);
    return { data: result };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutHandler(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(refreshTokenSchema)) body: RefreshTokenInput,
  ) {
    await this.logout.execute(user, body.refreshToken);
  }
}
