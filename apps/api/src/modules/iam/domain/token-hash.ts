import { createHash } from 'crypto';

/**
 * Refresh tokens are high-entropy signed JWTs (not user-chosen secrets),
 * so a fast SHA-256 digest is sufficient for the DB-side revocation
 * lookup - unlike passwords, there is no offline brute-force concern to
 * justify argon2 here.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
