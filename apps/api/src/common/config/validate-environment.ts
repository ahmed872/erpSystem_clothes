/**
 * Phase 11 — FAIL AT STARTUP, NOT AT THE FIRST LOGIN.
 *
 * Before this existed, a server missing `JWT_ACCESS_SECRET` started
 * cleanly, passed a health check, accepted traffic, and failed on the
 * first person who tried to sign in. A deploy could look successful and be
 * completely unusable, and the failure surfaced as a 500 to a customer
 * rather than as a refusal to boot.
 *
 * Everything checked here is checked BEFORE the Nest application is
 * created, so a misconfigured process dies immediately with a message
 * naming exactly what is wrong.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: the values themselves are never
 * logged, and no error message quotes a secret or a connection string. A
 * message that helpfully prints what it found is a message that puts a
 * password in a log aggregator.
 */

/** The minimum a signing secret can be and still be worth having. 32 bytes
 *  of entropy is the floor for HMAC-SHA256; shorter secrets are guessable
 *  offline from a single captured token. */
const MIN_SECRET_LENGTH = 32;

/** Values that appear in this repository's own `.env` files and in every
 *  tutorial. Present in production, they are the same as no secret at all. */
const KNOWN_DEV_SECRETS = new Set([
  'dev_access_secret_change_me',
  'dev_refresh_secret_change_me',
  'secret',
  'changeme',
  'change_me',
  'jwt_secret',
]);

export interface EnvironmentReport {
  errors: string[];
  warnings: string[];
}

/**
 * Validates the process environment and returns everything wrong with it,
 * rather than throwing on the first problem: an operator fixing a deploy
 * should see the whole list, not discover it one restart at a time.
 */
export function inspectEnvironment(env: NodeJS.ProcessEnv = process.env): EnvironmentReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = env.NODE_ENV === 'production';

  // The API connects as the restricted `erp_app` role. Connecting as the
  // owner would silently bypass every RLS policy in the schema, which is
  // the single most dangerous misconfiguration this system has.
  if (!env.RUNTIME_DATABASE_URL) {
    errors.push('RUNTIME_DATABASE_URL is not set. The API must connect via the restricted erp_app role.');
  } else if (isProduction && env.RUNTIME_DATABASE_URL === env.DATABASE_URL) {
    errors.push(
      'RUNTIME_DATABASE_URL must not equal DATABASE_URL. DATABASE_URL is the migration/owner connection and BYPASSES row-level security.',
    );
  }

  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    const value = env[key];
    if (!value) {
      errors.push(`${key} is not set.`);
      continue;
    }
    if (value.length < MIN_SECRET_LENGTH) {
      const message = `${key} is shorter than ${MIN_SECRET_LENGTH} characters, which is guessable offline from one captured token.`;
      isProduction ? errors.push(message) : warnings.push(message);
    }
    if (KNOWN_DEV_SECRETS.has(value.toLowerCase())) {
      const message = `${key} is a well-known development placeholder.`;
      isProduction ? errors.push(message) : warnings.push(message);
    }
  }

  // Signing access and refresh tokens with the same key means a refresh
  // token is a valid access token and vice versa - the type claim is the
  // only thing standing between them, and a type claim is not a boundary.
  if (env.JWT_ACCESS_SECRET && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    errors.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ: one key signing both means each token is valid as the other.');
  }

  if (isProduction) {
    // `origin: false` (the default when CORS_ORIGIN is unset) blocks every
    // browser origin. That is the safe default, but in production it is
    // almost always an oversight rather than an intention, so it is worth
    // saying out loud.
    if (!env.CORS_ORIGIN) {
      warnings.push('CORS_ORIGIN is not set, so no browser origin is allowed. Set it, or serve the frontend same-origin.');
    }
    if (env.SWAGGER_ENABLED === 'true') {
      warnings.push('SWAGGER_ENABLED=true publishes an unauthenticated map of every endpoint on this host.');
    }
  }

  return { errors, warnings };
}

/**
 * Called from `main.ts` before the application is built. Throws on any
 * error; warnings are printed and the process continues.
 */
export function assertEnvironmentIsUsable(env: NodeJS.ProcessEnv = process.env): void {
  const { errors, warnings } = inspectEnvironment(env);

  for (const warning of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[config] WARNING: ${warning}`);
  }
  if (errors.length > 0) {
    throw new Error(
      ['Refusing to start: the environment is not usable.', ...errors.map((e) => `  - ${e}`)].join('\n'),
    );
  }
}
