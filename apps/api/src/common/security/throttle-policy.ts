import { Throttle } from '@nestjs/throttler';

/**
 * Phase 11 — RATE LIMITS FOR THE ENDPOINTS THAT ACTUALLY GET ATTACKED.
 *
 * A global ceiling of 120 requests/minute per IP has been in place since
 * Phase 1. It protects the server from being flooded; it does nothing
 * about the attacks that matter here, because none of them need volume.
 * 120 password guesses a minute is 172,800 a day against one account, and
 * 120 business registrations a minute fills the tenant table faster than
 * anyone will notice.
 *
 * SCOPE, AND WHY IT STOPS WHERE IT DOES. Only unauthenticated or
 * credential-handling endpoints are tightened. Everything behind a token
 * already has two much stronger limits: the caller must hold a valid
 * session, and every action is permission-checked and audited. Throttling
 * a cashier's till because they scan quickly would be a real operational
 * cost for no security gain, so the ordinary API keeps the global ceiling.
 *
 * IN-MEMORY, PER PROCESS, DELIBERATELY. `@nestjs/throttler`'s default
 * storage is per-instance. Behind N instances the effective limit is N
 * times the number below, which is a real weakness and an accepted one:
 * the alternative is a shared Redis store, which means an availability
 * dependency and a new operational surface for a system that has neither
 * today. Introducing one to harden a single-instance deployment would add
 * more failure modes than it removes. When horizontal scaling arrives, the
 * fix is a storage adapter behind this same policy - the decorators below
 * do not change.
 *
 * The limits are per IP, which is what the library keys on. A NAT'd
 * office shares one budget; that is why the login limit is per minute
 * rather than per hour, so a shared address recovers quickly.
 */

/**
 * The limits are read from the environment at import time, with the
 * production-safe values below as defaults. They exist as configuration
 * for two reasons and no others: a deployment behind a shared NAT may need
 * a higher login budget, and the test suite - which registers hundreds of
 * businesses and signs in constantly - would otherwise be throttling
 * itself rather than testing anything. `.env.test` raises them; the
 * dedicated rate-limit spec lowers them again to prove the guard is real.
 */
function limitFrom(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MINUTE = 60_000;

/**
 * Sign-in. Ten attempts a minute is far more than a person mistyping a
 * password needs and far less than a dictionary attack wants.
 *
 * Note what this does NOT do: it does not lock an account. Per-account
 * lockout is a denial-of-service weapon - anyone who knows a cashier's
 * email can lock them out of the till during a shift - so the limit is on
 * the SOURCE, not the target.
 */
export const ThrottleLogin = () => Throttle({ default: { ttl: MINUTE, limit: limitFrom('RATE_LIMIT_LOGIN', 10) } });

/**
 * Public tenant creation. Five a minute is generous for a human signing up
 * and hostile to a script creating tenants in bulk. This is the one
 * endpoint that manufactures new top-level data with no credential at all.
 */
export const ThrottleRegistration = () => Throttle({ default: { ttl: MINUTE, limit: limitFrom('RATE_LIMIT_REGISTRATION', 5) } });

/**
 * Anything that changes or refreshes a credential: password change,
 * administrative reset, token refresh.
 *
 * Twenty a minute leaves an honest client - which refreshes on a timer,
 * not in a loop - untouched, while capping how fast a stolen refresh token
 * can be exercised and how fast an authenticated attacker can grind the
 * `currentPassword` check.
 */
export const ThrottleCredential = () => Throttle({ default: { ttl: MINUTE, limit: limitFrom('RATE_LIMIT_CREDENTIAL', 20) } });
