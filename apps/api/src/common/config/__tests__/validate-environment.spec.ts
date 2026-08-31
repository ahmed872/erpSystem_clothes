import { inspectEnvironment, assertEnvironmentIsUsable } from '../validate-environment';

/**
 * Phase 11 — the startup check, unit tested.
 *
 * A pure function over a plain object, so every misconfiguration can be
 * described exactly rather than approximated by standing a server up.
 * What is asserted here is not only WHICH conditions fail, but that the
 * failures NEVER quote a value: a message that helpfully prints what it
 * found is a message that puts a password in a log aggregator.
 */
describe('inspectEnvironment', () => {
  const good = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://owner:ownerpw@db:5432/erp',
    RUNTIME_DATABASE_URL: 'postgresql://erp_app:apppw@db:5432/erp',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    CORS_ORIGIN: 'https://shop.example',
  } as NodeJS.ProcessEnv;

  it('passes a correctly configured production environment with nothing to say', () => {
    expect(inspectEnvironment(good)).toEqual({ errors: [], warnings: [] });
    expect(() => assertEnvironmentIsUsable(good)).not.toThrow();
  });

  it('REFUSES to start with no runtime connection - the API must not connect as the owner', () => {
    const { RUNTIME_DATABASE_URL, ...without } = good;
    void RUNTIME_DATABASE_URL;
    expect(inspectEnvironment(without).errors).toEqual([expect.stringContaining('RUNTIME_DATABASE_URL is not set')]);
  });

  it('REFUSES a runtime connection equal to the migration connection, which bypasses RLS', () => {
    const shared = { ...good, RUNTIME_DATABASE_URL: good.DATABASE_URL };
    expect(inspectEnvironment(shared).errors).toEqual([expect.stringContaining('BYPASSES row-level security')]);

    // Outside production the same setting is tolerated: local development
    // runs one database and one role, and failing there would only teach
    // people to delete the check.
    expect(inspectEnvironment({ ...shared, NODE_ENV: 'development' }).errors).toEqual([]);
  });

  it('REFUSES a missing, short, or well-known signing secret in production', () => {
    const { JWT_ACCESS_SECRET, ...missing } = good;
    void JWT_ACCESS_SECRET;
    expect(inspectEnvironment(missing).errors).toEqual([expect.stringContaining('JWT_ACCESS_SECRET is not set')]);

    expect(inspectEnvironment({ ...good, JWT_REFRESH_SECRET: 'short' }).errors).toEqual([
      expect.stringContaining('shorter than 32 characters'),
    ]);
    expect(inspectEnvironment({ ...good, JWT_ACCESS_SECRET: 'dev_access_secret_change_me' }).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('well-known development placeholder')]),
    );
  });

  it('REFUSES one key signing both token types', () => {
    const same = 'c'.repeat(48);
    expect(inspectEnvironment({ ...good, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same }).errors).toEqual([
      expect.stringContaining('must differ'),
    ]);
  });

  it('reports EVERY problem at once, not the first one', () => {
    const { RUNTIME_DATABASE_URL, ...broken } = good;
    void RUNTIME_DATABASE_URL;
    const report = inspectEnvironment({ ...broken, JWT_ACCESS_SECRET: 'short', JWT_REFRESH_SECRET: '' });
    expect(report.errors.length).toBeGreaterThanOrEqual(3);
    // An operator fixing a deploy should see the whole list rather than
    // discovering it one restart at a time.
    expect(report.errors.join('\n')).toContain('RUNTIME_DATABASE_URL');
    expect(report.errors.join('\n')).toContain('JWT_ACCESS_SECRET');
    expect(report.errors.join('\n')).toContain('JWT_REFRESH_SECRET');
  });

  it('WARNS rather than refuses outside production, so development still boots', () => {
    const dev = { ...good, NODE_ENV: 'development', JWT_ACCESS_SECRET: 'dev_access_secret_change_me' };
    const report = inspectEnvironment(dev);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining('development placeholder')]));
    expect(() => assertEnvironmentIsUsable(dev)).not.toThrow();
  });

  it('warns about a production deployment that allows no browser origin, or publishes its own map', () => {
    const { CORS_ORIGIN, ...noCors } = good;
    void CORS_ORIGIN;
    expect(inspectEnvironment(noCors).warnings).toEqual([expect.stringContaining('CORS_ORIGIN is not set')]);
    expect(inspectEnvironment({ ...good, SWAGGER_ENABLED: 'true' }).warnings).toEqual([
      expect.stringContaining('unauthenticated map of every endpoint'),
    ]);
    // Neither is fatal: both can be deliberate.
    expect(inspectEnvironment(noCors).errors).toEqual([]);
  });

  it('NEVER quotes a secret or a connection string in any message', () => {
    const leaky = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://owner:SUPERSECRETPW@db:5432/erp',
      RUNTIME_DATABASE_URL: 'postgresql://owner:SUPERSECRETPW@db:5432/erp',
      JWT_ACCESS_SECRET: 'tiny',
      JWT_REFRESH_SECRET: 'tiny',
    } as NodeJS.ProcessEnv;

    const all = [...inspectEnvironment(leaky).errors, ...inspectEnvironment(leaky).warnings].join('\n');
    expect(all).not.toContain('SUPERSECRETPW');
    expect(all).not.toContain('tiny');
    expect(all).not.toContain('postgresql://');

    let thrown = '';
    try {
      assertEnvironmentIsUsable(leaky);
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).toContain('Refusing to start');
    expect(thrown).not.toContain('SUPERSECRETPW');
  });
});
