import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthTokenService } from '../auth-token.service';

describe('AuthTokenService', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      JWT_ACCESS_SECRET: 'access-secret-for-unit-tests-only',
      JWT_REFRESH_SECRET: 'refresh-secret-for-unit-tests-only',
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '30d',
    };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  function makeService() {
    return new AuthTokenService(new JwtService());
  }

  it('issues an access token that verifies back to the same claims', () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: 'u1', tenantId: 't1', email: 'a@b.com' });
    const claims = service.verifyAccessToken(token);
    expect(claims).toMatchObject({ sub: 'u1', tenantId: 't1', email: 'a@b.com', type: 'access' });
  });

  it('reports a 900s expiry for a 15m access TTL', () => {
    const service = makeService();
    const { expiresIn } = service.issueAccessToken({ userId: 'u1', tenantId: 't1', email: 'a@b.com' });
    expect(expiresIn).toBe(900);
  });

  it('rejects an access token signed with a different secret', () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: 'u1', tenantId: 't1', email: 'a@b.com' });
    process.env.JWT_ACCESS_SECRET = 'a-completely-different-secret';
    expect(() => service.verifyAccessToken(token)).toThrow(UnauthorizedException);
  });

  it('rejects a refresh token presented where an access token is expected', () => {
    const service = makeService();
    const { token } = service.issueRefreshToken({ userId: 'u1', tenantId: 't1' });
    // Refresh tokens are signed with a different secret AND carry type:'refresh',
    // so verifyAccessToken must reject them even if secrets ever collided.
    expect(() => service.verifyAccessToken(token)).toThrow(UnauthorizedException);
  });

  it('issues a refresh token with a fresh jti each time (never reused)', () => {
    const service = makeService();
    const a = service.issueRefreshToken({ userId: 'u1', tenantId: 't1' });
    const b = service.issueRefreshToken({ userId: 'u1', tenantId: 't1' });
    expect(a.jti).not.toBe(b.jti);
  });

  it('embeds the tenant id in the refresh token so it can be recovered before any DB call', () => {
    const service = makeService();
    const { token, jti } = service.issueRefreshToken({ userId: 'u1', tenantId: 't1' });
    const claims = service.verifyRefreshTokenSignature(token);
    expect(claims).toMatchObject({ sub: 'u1', tenantId: 't1', jti, type: 'refresh' });
  });
});
