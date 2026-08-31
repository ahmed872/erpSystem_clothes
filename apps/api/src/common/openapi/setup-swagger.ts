import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

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
