import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, OpenAPIObject } from '@nestjs/swagger';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Phase 10 (10I) — the browsable API contract.
 *
 * WHAT THIS IS NOT. It is not the source of truth for request shapes:
 * every endpoint validates through a Zod schema in `@retail/shared-
 * validation`, and those schemas are what a request is actually judged
 * against. Restating each of them as a decorated DTO class would create a
 * second definition of every payload, free to drift from the one that
 * enforces anything - and the first time they disagreed, the documentation
 * would be confidently wrong. The route map, the auth scheme and the
 * cross-cutting rules below are documented here; the payload shapes are
 * documented where they are enforced.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Retail Operating System API')
    .setVersion('10')
    .setDescription(CONTRACT_NOTES)
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  annotateAuthorization(app, document);
  SwaggerModule.setup('api/v1/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}

/**
 * The cross-cutting rules a client needs before it reads a single route -
 * the ones that are true of EVERY endpoint and would otherwise have to be
 * discovered by trial and error.
 */
const CONTRACT_NOTES = `
Every endpoint is tenant-scoped, server-authorized, and validated against a
Zod schema in \`@retail/shared-validation\`. Those schemas are the contract:
a request is judged against them, not against this page.

**Authentication.** \`POST /auth/login\` returns an access token and a
refresh token. Send the access token as \`Authorization: Bearer <token>\`.
Refresh tokens are single-use and are all revoked whenever the user's
password changes.

**Authorization is always server-side.** Every route names the permissions
it requires and the server re-reads the caller's effective permission set on
every request, so revoking a role takes effect immediately. Some responses
are additionally *field-stripped*: without \`products.view_cost\` a sale
carries no cost or profit, and without \`shifts.view_expected\` a shift
carries no expected-cash or variance figure. Those fields are absent from
the payload, not merely hidden by a client.

**IDEMPOTENCY — FROZEN CONTRACT (Phase 10, 10I).** An idempotency key
travels in the REQUEST BODY, as an \`idempotencyKey\` field, on every
endpoint that accepts one. It is deliberately NOT an \`Idempotency-Key\`
header. The key belongs to the business document being created — a sale, a
goods receipt, an expense — and the body is where that document is
described; a transport header would let the same key be attached to two
different payloads at different layers, which is exactly the confusion the
key exists to prevent. Offline clients that replay a queued request send it
back byte-identical, body and all, and get the original document.

Replaying a key with a MATERIALLY DIFFERENT payload returns **409**, never
the original document. "Materially different" is judged on a canonical
fingerprint of the business facts of the request — quantities normalised,
lines sorted — and deliberately excludes anything the SERVER produced
rather than the client: promotion discounts, loyalty redemption, and
exchange credit are all absent from it, because none of them were part of
the request being replayed.

**Money.** Every monetary value is a decimal serialised as a STRING, to 4
decimal places, and must be parsed as a decimal — never as a float.
Rounding is HALF-UP at 4dp throughout.

**Errors.** \`422\` for a request that cannot be valid, \`409\` for one that
conflicts with the current state of the world (insufficient stock, a
document already closed, an idempotency key reused differently), \`403\`
for a missing permission, \`404\` for anything outside the caller's tenant —
a cross-tenant row is invisible, not merely forbidden.
`;


/**
 * Stamps each operation with the permissions it actually requires, and
 * marks the ones that need no token.
 *
 * THE POINT IS THAT THIS CANNOT DRIFT. The permissions are read from the
 * SAME `@RequirePermissions` metadata `PermissionsGuard` reads at runtime,
 * and the public flag from the same `@Public` metadata `JwtAuthGuard`
 * reads. Hand-written `@ApiOperation` text describing what a route needs
 * would be a second statement of the same fact, free to fall out of step
 * the first time a permission changed - and documentation that is
 * confidently wrong about authorization is worse than none.
 */
function annotateAuthorization(app: INestApplication, document: OpenAPIObject): void {
  const server = app.getHttpAdapter().getInstance();
  const controllers = collectControllers(app);

  for (const controller of controllers) {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) ?? '';
    const prototype = controller.prototype;
    if (!prototype) continue;

    for (const methodName of Object.getOwnPropertyNames(prototype)) {
      if (methodName === 'constructor') continue;
      const handler = prototype[methodName];
      if (typeof handler !== 'function') continue;

      const methodPath = Reflect.getMetadata(PATH_METADATA, handler);
      if (methodPath === undefined) continue;

      const verb = HTTP_VERB[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      if (!verb) continue;

      const required: string[] =
        Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? Reflect.getMetadata(PERMISSIONS_KEY, controller) ?? [];
      const isPublic =
        Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? Reflect.getMetadata(IS_PUBLIC_KEY, controller) ?? false;

      const path = toOpenApiPath(controllerPath, methodPath);
      const operation = (document.paths[path] as Record<string, { description?: string }> | undefined)?.[verb];
      if (!operation) continue;

      const note = isPublic
        ? '**No authentication required.**'
        : required.length === 0
          ? '**Requires a valid access token.** No additional permission.'
          : `**Requires a valid access token, and ALL of:** ${required.map((c) => `\`${c}\``).join(', ')}.`;
      operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
    }
  }
  void server;
}

const HTTP_VERB: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

/** `sales` + `:id/receipt` -> `/api/v1/sales/{id}/receipt`, matching the
 *  shape the generated document uses as its key. */
function toOpenApiPath(controllerPath: string, methodPath: string): string {
  const joined = [controllerPath, methodPath].filter((part) => part && part !== '/').join('/');
  const withParams = joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return `/api/v1/${withParams}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/api/v1';
}

/** Walks the Nest module graph for every controller class. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectControllers(app: INestApplication): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const container = (app as any).container;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (const module of container.getModules().values()) {
    for (const wrapper of module.controllers.values()) {
      if (wrapper.metatype) out.push(wrapper.metatype);
    }
  }
  return out;
}
