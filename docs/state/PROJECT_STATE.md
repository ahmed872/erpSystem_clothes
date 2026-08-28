# PROJECT STATE SUMMARY

## Current Phase
Phase 1 — Foundation (**Complete, awaiting explicit approval to start Phase 2**)

## Completed Features
- **Monorepo scaffold**: npm workspaces (`apps/api`, `packages/shared-types`, `packages/shared-validation`), shared TypeScript types/zod schemas consumed by both the API and (later) the offline POS client.
- **Multi-tenant PostgreSQL schema + Row-Level Security**, enforced at the database layer via a restricted `erp_app` runtime role (see Architecture Decisions).
- **Auth**: business login (`email + password + businessSlug`), argon2id password hashing, short-lived JWT access tokens, signed-JWT refresh tokens with rotation + individual revocation, logout, generic "Invalid email or password" (no tenant/user enumeration), LOGIN/LOGIN_FAILED/LOGOUT audit trail.
- **Business onboarding**: single atomic transaction creating Business + default Branch + default Warehouse + all 6 built-in Role templates (with default permission grants) + Owner user, assigned the BUSINESS_OWNER role and default branch.
- **Users**: create/list/update/suspend, role & branch assignment, "last active Business Owner" lockout protection (cannot suspend or de-own the only owner), passwordHash never serialized in any response.
- **Roles & Permissions**: global permission catalog (23 codes) seeded at deploy time; per-tenant Roles CRUD with permission-code assignment; role deletion blocked for built-in templates and for roles still assigned to users.
- **Business profile**: get/update.
- **Branches**: create/list/update (soft `isActive` toggle, no hard delete).
- **Warehouses**: create/list/update, scoped to a branch, single-default-per-branch invariant enforced on create/update.
- **Settings**: generic per-business key/value store (get/upsert).
- **Audit log**: append-only, written inside the same DB transaction as the change it documents, immutable at the database privilege level (no UPDATE/DELETE grant for the runtime role).
- **Server-side authorization everywhere**: every protected route re-reads the caller's current permission grants from the database on each request (not cached in the JWT), so a revoked permission/role takes effect on the very next request.

## Pending Features
Everything from Phase 2 onward per `docs/architecture/PHASE-0-ARCHITECTURE.md` §15 (Catalog, Inventory Engine, Purchasing, POS, Finance/Accounting, Reports, Advanced, Security & Reliability hardening, Production).

Explicitly NOT built in Phase 1 (by design, out of scope per the Phase 0 plan):
- No frontend (`apps/erp-web`, `apps/pos-web`) yet — Phase 1 was scoped as the backend foundation; the acceptance criteria for this phase are business-logic/API-driven, not UI-driven. **Flagging this explicitly for your review before Phase 2** in case you want a minimal ERP shell started sooner.
- No email/SMS invite flow for new users (they're created with a password directly by an admin) — invite-by-email needs the Notifications module (Phase 8).
- No password-reset flow, no 2FA.

## Architecture Decisions
Carried over unchanged from Phase 0 (Modular Monolith; NestJS + TypeScript + PostgreSQL 16 + Prisma; Redis+BullMQ reserved for later phases — not yet wired into any Phase 1 code path). One decision was **added** (not a change to a prior one):

- **Multi-tenancy mechanism, concretely implemented**: shared schema, `business_id` column, PostgreSQL Row-Level Security with `FORCE ROW LEVEL SECURITY`. The API's Prisma client connects as a dedicated `erp_app` database role (`NOSUPERUSER NOBYPASSRLS`) — never as the migration/superuser role — and every tenant-scoped query runs inside `PrismaService.withTenant(tenantId, ...)`, which opens a transaction and issues `SET LOCAL app.current_tenant_id = '<uuid>'` before the caller's queries run. Default posture is **deny**: if the session variable is ever left unset (a bug forgetting to call `withTenant`), every tenant-scoped table returns zero rows / rejects every write, rather than leaking cross-tenant data. `businesses` itself is the one deliberate exception — SELECT is public (`USING (true)`) so login can resolve a tenant by its public slug before any tenant context exists; INSERT/UPDATE still require the row's own `id` to equal the tenant context, so business onboarding generates the business id application-side and opens the tenant context to that id *before* inserting the business row — no special-cased bypass needed anywhere.
- **Refresh tokens are signed JWTs, not opaque random strings** (a Phase 1 concretization of the Phase 0 auth design), carrying `tenantId` as a claim so the API can recover which tenant to open RLS context for *before* querying the database — solving the chicken-and-egg problem of "look up a token row" under default-deny RLS. Each refresh token still has a DB-side row (hash + revocation state) so it remains individually revocable, and is rotated (old row revoked, new one issued) on every use.
- **Authorization is re-checked from the database on every request**, not cached in the access token, trading one extra indexed join per request for immediate effect of permission/role changes and immediate lockout of suspended users — verified by test (`rbac.e2e-spec.ts`).
- **Audit immutability enforced at two independent layers**: application code never calls update/delete on `AuditLog`, AND the `erp_app` database role has no UPDATE/DELETE grant on `audit_logs` at all (verified by test: attempting either via a raw query as `erp_app` fails with a Postgres permission-denied error, independent of application code).
- **No hard delete for `businesses`**: the `erp_app` role has no DELETE grant on that table at all (verified by test). Branches/warehouses use soft `isActive` toggles at the application layer. Roles ARE hard-deletable (not a financial document) but only when unused by any user and not a built-in template.

## Database Changes
New Prisma models (see `apps/api/prisma/schema.prisma`): `Business`, `Branch`, `Warehouse`, `User`, `UserBranch`, `Role`, `Permission`, `UserRole`, `RolePermission`, `RefreshToken`, `Setting`, `AuditLog`. Enums: `BusinessStatus`, `UserStatus`, `AuditAction`.

All money/inventory-relevant models from later phases (Product, StockMovement, JournalEntry, etc.) are intentionally NOT modeled yet.

## Migrations
1. `20260828121159_init` — base tables from the Prisma schema above.
2. `20260828121500_enable_row_level_security` — enables + forces RLS and creates the isolation policies on `businesses`, `branches`, `warehouses`, `users`, `roles`, `settings`, `audit_logs`, and the join tables `user_roles`, `user_branches`, `role_permissions`, `refresh_tokens` (scoped transitively via their parent row's tenant).
3. `20260828121600_lockdown_app_role` — creates the restricted `erp_app` role (`NOSUPERUSER NOBYPASSRLS`) and grants exactly the privileges each table needs (no DELETE on `businesses`; SELECT+INSERT only, no UPDATE/DELETE, on `audit_logs`; read-only on the global `permissions` catalog).

Applied and verified against both `erp_dev` and `erp_test` databases. `prisma/seed.ts` seeds the 23-entry global permission catalog (run with the migration/owner `DATABASE_URL`, never the runtime role).

**Deployment note carried into this phase**: `erp_app`'s password is a documented development default baked into migration 3 (plain SQL has no secret templating) — production deployments MUST rotate it via `ALTER ROLE` through the secrets pipeline immediately after first deploy. Documented in the migration file and `.env.example`.

## API Endpoints
All under `/api/v1`, JSON envelope `{ data }` on success / `{ error: { code, message, details, requestId } }` on failure.

| Method | Path | Auth | Permission |
|---|---|---|---|
| POST | `/businesses/register` | Public | — |
| POST | `/auth/login` | Public | — |
| POST | `/auth/refresh` | Public | — |
| POST | `/auth/logout` | Bearer | — |
| GET | `/business` | Bearer | `business.view` |
| PATCH | `/business` | Bearer | `business.edit` |
| GET | `/branches` | Bearer | `branches.view` |
| POST | `/branches` | Bearer | `branches.create` |
| PATCH | `/branches/:id` | Bearer | `branches.edit` |
| GET | `/warehouses?branchId=` | Bearer | `warehouses.view` |
| POST | `/warehouses` | Bearer | `warehouses.create` |
| PATCH | `/warehouses/:id` | Bearer | `warehouses.edit` |
| GET | `/settings` | Bearer | `settings.view` |
| PUT | `/settings` | Bearer | `settings.edit` |
| GET | `/users` | Bearer | `users.view` |
| POST | `/users` | Bearer | `users.create` |
| PATCH | `/users/:id` | Bearer | `users.edit` |
| DELETE | `/users/:id` (soft-suspends) | Bearer | `users.delete` |
| GET | `/roles` | Bearer | `roles.view` |
| POST | `/roles` | Bearer | `roles.create` |
| PATCH | `/roles/:id` | Bearer | `roles.edit` |
| DELETE | `/roles/:id` | Bearer | `roles.delete` |
| GET | `/permissions` | Bearer | `permissions.view` |

All request bodies validated against the shared zod schemas in `packages/shared-validation` (same schemas will be reused by the POS offline client from Phase 5 onward).

## Screens
None. Phase 1 delivered the backend foundation only — see "Pending Features" above for the explicit flag on frontend scope.

## Tests and Results
- **Unit** (`apps/api/src/**/*.spec.ts`, no DB): `AuthTokenService` (6 tests — issue/verify roundtrip, correct expiry-seconds conversion, wrong secret rejected, refresh token rejected where an access token is expected, fresh jti per issuance, tenant id recoverable from a refresh token's signature alone) and `PasswordHasherService` (5 tests — hash/verify roundtrip, wrong password rejected, hash never contains plaintext, salted so repeated hashes differ, malformed hash fails closed rather than throwing). **11/11 pass.**

- **E2E** (`apps/api/test/*.e2e-spec.ts`, real NestJS app + real PostgreSQL `erp_test`, no mocks): **28/28 pass**, across 5 files:
  - `onboarding.e2e-spec.ts` — atomic creation of business+branch+warehouse+6 roles+owner in one transaction; duplicate-slug rejected with 409 and zero side effects; weak password / invalid slug rejected with 422 before touching the DB.
  - `auth.e2e-spec.ts` — wrong password / unknown business both return the same generic message; LOGIN_FAILED audit rows recorded; successful login works end-to-end against a protected route; refresh-token rotation and rejection of a replayed/consumed token; logout revokes the refresh token; a user suspended mid-session is rejected on the very next request despite an unexpired access token.
  - `rbac.e2e-spec.ts` — no token → 401; a Cashier is blocked (403) from an action outside their permissions even though the button would be hidden client-side; revoking a permission from a role takes effect on the next request without waiting for token expiry; the last active Business Owner cannot be suspended/de-owned; a role with assigned users cannot be deleted; a built-in role template cannot be deleted even when unused.
  - `tenancy.e2e-spec.ts` — branch/warehouse CRUD, duplicate-name conflicts, invalid branch reference on warehouse creation, single-default-warehouse-per-branch invariant, settings upsert idempotency, branch deactivation is a soft update.
  - `tenant-isolation.e2e-spec.ts` — the most important suite: proves isolation at **both** the API layer (tenant B never sees tenant A's branches; cannot patch tenant A's branch by id, gets 404 not 200) **and independently at the PostgreSQL layer**, by connecting directly as the same restricted `erp_app` role the API uses and issuing completely raw, unfiltered SQL: a query with no `WHERE` clause at all returns zero rows with no tenant context set; setting context to tenant A returns only tenant A's rows; attempting to INSERT a row for tenant A while context is set to tenant B is rejected by the RLS `WITH CHECK` policy; `UPDATE`/`DELETE` on `audit_logs` and `DELETE` on `businesses` fail with a Postgres permission-denied error regardless of RLS, because the role was never granted those privileges at all.

- A real bug was caught and fixed by this test suite during development: the login use case originally wrote the `LOGIN_FAILED` audit row and then `throw`n the auth error from inside the same Prisma transaction — since a thrown error inside `$transaction()` rolls back everything written in it, the audit row was being silently discarded on every failed login. Fixed by returning a discriminated result from the transaction and throwing only after it commits (`login.use-case.ts`). This is exactly the class of "quiet transactional bug" the required end-to-end tests are supposed to surface.

## Security Review
- Passwords: argon2id, never logged, never serialized in any API response (`USER_SAFE_SELECT` used everywhere `User` is returned; verified by test).
- AuthN: stateless short-lived (15m) JWT access tokens; signed, rotating, individually-revocable refresh tokens (30d).
- AuthZ: 100% server-side, re-checked from the DB per request; the frontend (not yet built) will never be the source of authorization truth by construction.
- Tenant isolation: enforced at the database layer via RLS + a non-superuser, non-bypass runtime role — not merely an application-level `WHERE` clause — verified with raw-SQL tests that deliberately skip the application layer.
- Injection: all data access goes through Prisma's parameterized query builder; the one raw-SQL statement (`SET LOCAL app.current_tenant_id = '<value>'`, which Postgres's wire protocol cannot parameterize) is guarded by a strict UUID-format check before interpolation, and the value only ever originates from a server-generated UUID or a claim out of a token this server itself signed.
- Standard security headers via `helmet`; CORS locked to an explicit allow-list from `CORS_ORIGIN`, closed by default if unset.
- Rate limiting: a global `ThrottlerModule` guard (120 req/min) is active. **Known gap**: no tighter, auth-specific throttle on `/auth/login` yet for brute-force resistance — flagged below.
- Every sensitive mutation (business/branch/warehouse/user/role create & update, role delete, login/login-failed/logout) writes an audit row in the same DB transaction as the change; the row is immutable both by convention and by database grant.
- No secrets committed: `.env`/`.env.test` are gitignored; `.env.example` documents every variable with a placeholder and explains the two-role (`DATABASE_URL` vs `RUNTIME_DATABASE_URL`) connection split and why mixing them up would silently disable RLS.

## Business Logic Review
- Uniqueness enforced where the domain requires it: business slug (global), user email (per business), branch name (per business), warehouse name (per branch), role name (per business) — all via DB unique constraints, with a friendly pre-check plus the constraint itself as the ultimate guard (`P2002` mapped to `409 CONFLICT`).
- Every write that matters is wrapped in `PrismaService.withTenant(...)`, i.e. a single DB transaction: onboarding either creates business+branch+warehouse+6 roles+owner entirely, or none of it persists.
- Two explicit lockout-prevention invariants, both tested: (1) the last active Business Owner of a tenant can never be suspended or stripped of that role; (2) a role cannot be deleted while still assigned to any user, and built-in role templates can never be deleted.
- Setting a warehouse as default automatically un-defaults the previous default within the same branch (never two defaults at once).
- No feature reads `Product.quantity`-style denormalized truth (not applicable yet — no Product model exists until Phase 2 — but the audit/ledger discipline this pattern requires is already established here for `AuditLog` and will carry into `StockMovement`/`JournalEntry`).

## Known Issues / Technical Debt
1. **No frontend yet.** Flagged for your explicit decision before Phase 2 (see "Pending Features").
2. **`/auth/login` shares the global 120 req/min throttle** rather than a tighter dedicated brute-force limit. Recommend a per-route override (e.g. 10/min per IP+email) in a near-term follow-up, not deferred to a specific later phase in the original plan.
3. **Refresh-token reuse is rejected but doesn't trigger a defensive cascade** (e.g., revoking all of that user's other active sessions as a theft response) — it just fails that one request with 401. Worth adding once Phase 6+ makes session hijacking a higher-value target.
4. **`erp_app`'s database password is a checked-in development default** (by necessity — plain SQL migrations can't read secrets); production deployment MUST rotate it immediately post-deploy. Documented in the migration file and `.env.example`, repeating it here so it isn't missed.
5. **No email/SMS invite, password-reset, or 2FA flow** — deferred; the Notifications module (Phase 8) and a dedicated auth-hardening pass are the natural homes for these.
6. Redis/BullMQ are provisioned in `docker-compose.yml` but not yet used by any Phase 1 code path (no jobs exist yet to queue).

## Important Business Rules (running reference, unchanged + Phase 1 additions)
1. StockMovement = future source of inventory truth; JournalEntryLine = future source of financial truth (still Phase 3/6, not built).
2. Every critical write = one atomic DB transaction (established pattern via `PrismaService.withTenant`, exercised so far by onboarding, user/role/branch/warehouse mutations, and login).
3. No hard delete of financial/sensitive documents. Phase 1 concretization: `businesses` and `audit_logs` cannot be hard-deleted even at the database-privilege level, independent of application code.
4. Authorization is always re-verified server-side and always fresh (never trust a cached/JWT-embedded permission snapshot).
5. Tenant isolation is enforced by the database (RLS), not only by application code.

## Next Phase
**Phase 2 — Products & Catalog**: Products, Variants, Attributes, UOM, Barcodes, Prices, Bundles.
**Will not start until you explicitly approve this Phase 1 report.**
