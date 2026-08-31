import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import {
  loginSchema,
  refreshTokenSchema,
  LoginInput,
  RefreshTokenInput,
  changeOwnPasswordSchema,
  ChangeOwnPasswordInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { ThrottleLogin, ThrottleCredential } from '../../../common/security/throttle-policy';
import { Public } from '../../../common/decorators/public.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { LoginUseCase } from '../application/auth/login.use-case';
import { RefreshTokenUseCase } from '../application/auth/refresh-token.use-case';
import { LogoutUseCase } from '../application/auth/logout.use-case';
import { ChangePasswordUseCase } from '../application/users/change-password.use-case';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly login: LoginUseCase,
    private readonly refresh: RefreshTokenUseCase,
    private readonly logout: LogoutUseCase,
    private readonly passwords: ChangePasswordUseCase,
  ) {}

  @Public()
  @ThrottleLogin()
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
  @ThrottleCredential()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshHandler(@Body(new ZodValidationPipe(refreshTokenSchema)) body: RefreshTokenInput) {
    const result = await this.refresh.execute(body.refreshToken);
    return { data: result };
  }

  /**
   * Phase 10 (10G): a user changes their OWN password.
   *
   * Deliberately NOT gated on any permission - every authenticated user
   * may change their own password, whatever else they can or cannot do,
   * and requiring a permission for it would be a way to trap someone with
   * a compromised password.
   *
   * The current password is required. A signed-in session on an unattended
   * till is the ordinary case in a shop, and without that check anyone
   * walking past could lock the real user out of their own account.
   */
  @ThrottleCredential()
  @Post('password')
  @HttpCode(HttpStatus.OK)
  async changePasswordHandler(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(changeOwnPasswordSchema)) body: ChangeOwnPasswordInput,
  ) {
    return { data: await this.passwords.changeOwn(user, body) };
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
