# PROJECT STATE SUMMARY

## Current Phase
Phase 2 — Products & Catalog (**Complete, awaiting explicit approval to start Phase 3**)

## Completed Features

### Phase 1 (unchanged, carried forward)
- Monorepo scaffold, multi-tenant PostgreSQL + RLS, Auth (login/refresh/logout), Business onboarding, Users, Roles & Permissions, Branches, Warehouses, Settings, append-only Audit log, server-side authorization re-checked per request.
- See git history / the previous revision of this file for the full Phase 1 write-up; nothing about it changed in Phase 2 except where called out below.

### Phase 2 (new)
- **Categories**: tree via self-referential `parentId`, unique name per sibling level including the top level (partial unique index — a plain composite unique constraint cannot catch two NULL-parent rows), cycle-detection guard on re-parenting (a category can never become its own ancestor or descendant), 404 when `parentId` references another tenant's category.
- **Brands**: create/list/update, unique name per tenant, soft `isActive` toggle.
- **Units of Measure (UOM)**: create/list/update, unique name+code per tenant, `precision` (0-6 decimal places, DB `CHECK`-enforced) that later phases will use to reject fractional "pieces" while allowing fractional kilograms.
- **Attributes & values**: dynamic, tenant-defined attribute types (e.g. "Color") and their values (e.g. "Black") — never hardcoded to clothing. Value deletion blocked while still referenced by any variant.
- **Products**: full CRUD (create/list/get/update), SKU unique per tenant, `type` (`SIMPLE`/`BUNDLE`), `status` (`ACTIVE`/`INACTIVE`/`DISCONTINUED`), category/brand/base-UOM references validated against the caller's own tenant, `minimumStock`/`maximumStock` with a `maximumStock >= minimumStock` DB `CHECK`, non-negative-money `CHECK` constraints on cost/price fields.
- **Product Variants**: every Product always has at least one Variant — a "simple" product with no explicit variants gets exactly one auto-generated default variant (same SKU as the product) at creation time, so Inventory (Phase 3) and Sales (Phase 5) only ever need to key off `variantId`, never branch on "is this a bare product or a variant". Variants added explicitly get their own SKU, optional per-variant cost/selling-price override (inherits the product's defaults otherwise), weight, and attribute-value combination.
- **Cross-table SKU uniqueness**: SKU is a single flat lookup namespace shared by `Product` and `ProductVariant` even though they're different tables — enforced at the application layer (`assertSkuAvailable`) before every insert, since Postgres can't express a cross-table unique constraint without an artificial shared lookup table.
- **Attribute-combination integrity**: a variant can never carry two values for the same attribute (DB-enforced via a composite FK from `VariantAttributeValue` to `ProductAttributeValue(id, attributeId)` — the database itself rejects a mismatched pair, not just application code), and two variants of the same product can never share the exact same combination of attribute values (checked both within one creation request and against already-persisted variants when adding one later).
- **Barcodes**: multiple per variant, globally unique per tenant, at most one `isPrimary=true` per variant (DB partial unique index), optionally tied to a specific `ProductUom` (pack-level barcode, e.g. a carton's own barcode vs. the piece's).
- **Multi-UOM / conversion factor**: a product's base UOM is implicit (factor 1, never duplicated); additional purchase/sales UOMs are recorded per product with a positive `conversionFactor` (DB `CHECK`-enforced) - e.g. "1 Carton = 12 Pieces" where Carton's factor is 12 relative to the product's own base UOM (Piece). Adding the base UOM itself as an "extra" UOM is rejected.
- **Bundles**: a Bundle is a `Product` with `type=BUNDLE` — it still gets its own sellable default variant, but carries no inventory of its own. `BundleItem` rows list the component variants + quantities. A bundle cannot contain another bundle (no nested bundles), cannot contain itself, and must have at least one item; a `SIMPLE` product cannot carry bundle items. Composition is replaceable via a dedicated endpoint after creation.
- **Price change history**: every variant cost change, selling-price change, and price-list entry change writes an immutable `ProductPriceHistory` row (old value, new value, who, when) - append-only at the database privilege level, same treatment as `AuditLog`.
- **Price Lists**: named pricing tiers (e.g. Wholesale, VIP), at most one `isDefault=true` per tenant (DB partial unique index, same pattern as the default-warehouse invariant from Phase 1), per-variant price entries via upsert.
- **Field-level authorization**: `products.view_cost` gates whether `cost`/`defaultCost` fields are present at all in a response (stripped server-side via a shared `EffectivePermissionsService`, not just hidden by a not-yet-built frontend) — covers product list, product detail, variant detail, barcode/SKU lookup, and the catalog sync endpoint uniformly.
- **POS-shaped read APIs, built now rather than deferred**: `GET /catalog/variants/lookup?barcode=|sku=` (the exact operation a cashier performs on every scan) and `GET /catalog/sync?updatedSince=&includeInactive=` (a bulk/delta catalog read shaped for POS caching and, later, offline-first priming in Phase 5) — per your instruction to design APIs now that later phases won't need to redesign.

## Pending Features
Everything from Phase 3 onward per `docs/architecture/PHASE-0-ARCHITECTURE.md` §15 (Inventory Engine, Purchasing, POS, Finance/Accounting, Reports, Advanced, Security & Reliability hardening, Production).

Still explicitly NOT built (carried over from Phase 1, unchanged):
- No frontend (`apps/erp-web`, `apps/pos-web`).
- No email/SMS invite flow, password reset, or 2FA.

New Phase-2-specific deferrals (deliberate, not scope cuts — see "Known Issues" for the reasoning on each):
- No hard-delete endpoints for Category/Brand/UOM/PriceList (soft `isActive` only) or for Product/ProductVariant (status only) — consistent with the Phase 1 "no hard delete once something matters" posture, extended proactively here because these will be heavily referenced by Inventory/Purchasing/Sales starting next phase.
- `Product.defaultCost`/`defaultSellingPrice` are creation-time defaults only, not independently editable afterward (see Architecture Decisions) — this is a considered design choice, not an oversight.
- Bundle stock consumption / COGS calculation is NOT implemented — that requires `StockMovement`, which is Phase 3. Phase 2 only defines the bundle *composition* (`BundleItem`).
- Attachments/real image upload infra does not exist yet, so `images` on Product/Variant is a JSON array of `{url, altText, sortOrder}` the caller supplies (validated as real URLs) rather than an upload endpoint.

## Architecture Decisions
Carried over unchanged from Phase 0 and Phase 1 (Modular Monolith; NestJS + TypeScript + PostgreSQL 16 + Prisma; RLS + restricted `erp_app` runtime role for tenant isolation; server-side-only authorization re-checked per request; append-only ledgers immutable at the DB privilege level). New decisions made in Phase 2, each explained:

- **A Product always has ≥1 ProductVariant; "simple" products auto-get a default one.** Alternative considered: let Sales/Inventory special-case "products without variants". Rejected because it would duplicate branching logic into every future module that touches a sellable item. One uniform join key (`variantId`) everywhere is simpler and matches how the spec itself talks about variant-level cost/price/barcode.
- **A Bundle is a Product with `type=BUNDLE`, not a separate entity.** It gets the same auto-created default variant as any simple product (that's what actually gets scanned/sold), and `BundleItem` only describes composition. This directly satisfies the spec's "a bundle must not be treated as an independent product with fake inventory" requirement: the bundle variant itself will never get a `StockBalance` row once Phase 3 exists — its availability will be derived from components.
- **SKU is one flat namespace across `Product` and `ProductVariant`, enforced at the application layer.** Two different tables each have their own per-table unique constraint (so Prisma/Postgres alone would allow a Product SKU to collide with an unrelated Variant SKU), but a POS/ERP "search by SKU" must never be ambiguous about which table it hit. `assertSkuAvailable()` checks both tables before every insert. Documented as an explicit cross-table invariant that could not be expressed as a single DB constraint without introducing an artificial shared lookup table, which was judged not worth the complexity for Phase 2.
- **A variant's attribute-value pairing is enforced by a composite foreign key**, not just application code: `VariantAttributeValue(variantId, attributeId, attributeValueId)` has a composite FK `(attributeValueId, attributeId) -> ProductAttributeValue(id, attributeId)`, so the database itself rejects recording a value against the wrong attribute. This is the same "defense in depth, not just app discipline" posture as Phase 1's audit-log immutability.
- **`Product.defaultCost`/`defaultSellingPrice` are creation-time defaults, not independently mutable afterward.** Considered making them freely PATCH-able like any other product field, but that would create two competing "sources of truth" for a simple product's price (the Product's default vs. its one Variant's actual price). Instead, all operational cost/price changes happen at the Variant level through dedicated, permission-gated, history-logging endpoints (`PATCH /catalog/variants/:id/cost`, `.../price`) — for a simple product this is effectively "the" price change path; for a multi-variant product it's the only sensible granularity anyway.
- **Reference/config catalog tables (Category, Brand, UOM, PriceList) support hard delete at the database-privilege level but Phase 2 does not expose a delete endpoint for them** — only soft `isActive` toggles. Product/ProductVariant go further: the `erp_app` role has no DELETE grant on `products`/`product_variants` at all (extending the Phase 1 "no hard delete once something matters" posture proactively, since Inventory/Purchasing/Sales will reference these starting Phase 3).
- **Cost visibility is enforced server-side per response, not per-route.** `products.view_cost` is checked inside the same tenant transaction as the data query (via the new shared `EffectivePermissionsService`, extracted from `PermissionsGuard` so the exact same "what can this user do right now" logic isn't duplicated) and cost fields are stripped from the returned object before it ever leaves the use-case — never a client-side filter.
- **`shared-validation`'s primitives (`nameSchema`, `emailSchema`, ...) were extracted into their own `primitives.ts` module.** The new `catalog.ts` schema file needed `nameSchema`, and importing it back from `index.ts` (which also re-exports `catalog.ts`) would have created a circular module dependency that is fragile in CommonJS (a schema could evaluate to `undefined` depending on require order). This is a structural refactor with no behavior change — every schema previously exported from `index.ts` still is.

## Database Changes
14 new Prisma models: `Category`, `Brand`, `Uom`, `ProductAttribute`, `ProductAttributeValue`, `Product`, `ProductVariant`, `VariantAttributeValue`, `ProductUom`, `Barcode`, `PriceList`, `ProductPrice`, `ProductPriceHistory`, `BundleItem`. New enums: `ProductType`, `ProductStatus`, `ProductVariantStatus`, `PriceChangeType`.

27 new global permission codes (50 total now; see `packages/shared-types/src/permissions.ts`): `products.{view,view_cost,create,edit,change_price,change_cost,delete}`, `categories.*`, `brands.*`, `uoms.*`, `attributes.*`, `pricelists.{view,create,edit,manage_prices}`.

## Migrations
1. `20260828124217_catalog_schema` — the 14 tables/4 enums above, plus hand-written additions Prisma's schema DSL cannot express: three partial unique indexes (top-level category name uniqueness, one-primary-barcode-per-variant, one-default-price-list-per-tenant) and a set of `CHECK` constraints (non-negative cost/price/stock-threshold, `maximumStock >= minimumStock`, positive UOM conversion factor and bundle-item quantity, UOM precision in `[0,6]`).
2. `20260828124500_catalog_rls` — enables + forces RLS on all 14 tables, same default-deny pattern as Phase 1's migration 2: 12 tables scoped directly by their own `business_id`; `variant_attribute_values` and `bundle_items` (pure join tables with no `business_id` column of their own) scoped transitively via their parent row's tenant, exactly like Phase 1's `user_roles`/`role_permissions`.
3. `20260828124600_catalog_app_role_grants` — extends `erp_app`'s privileges: full CRUD on reference/config tables (categories, brands, uoms, attributes, product_uoms, barcodes, price_lists, product_prices, and the two join tables); SELECT/INSERT/UPDATE-only (no DELETE) on `products`/`product_variants`; SELECT/INSERT-only (no UPDATE/DELETE) on `product_price_history`.

Applied and verified against both `erp_dev` and `erp_test` (`prisma migrate status` reports both "up to date", 6 migrations total across Phase 1+2).

`prisma/seed.ts` was extended: seeding now also **backfills every existing `BUSINESS_OWNER` role with any permission codes it doesn't yet have.** This matters because a Role's grants are a stored snapshot (`RolePermission` rows), not computed dynamically from "is this the owner role" — without the backfill, a business onboarded before Phase 2 would have permanently lost access to every new Phase 2 permission. Verified live: re-running the seed against `erp_dev` (which already had a business from earlier manual testing) reported `Backfilled 27 permission grant(s) across 1 BUSINESS_OWNER role(s)`. Other role templates' new default grants only apply to businesses onboarded from now on; existing tenants can grant them manually via the Phase 1 Roles API if desired — deliberately not auto-modifying a tenant's customized roles for anything less than the hard "owner always has everything" invariant.

## API Endpoints
All new endpoints under `/api/v1/catalog`, same `{ data }` / `{ error }` envelope as Phase 1 (list endpoints additionally return `pagination`).

| Method | Path | Permission |
|---|---|---|
| GET/POST | `/catalog/categories` | `categories.view` / `.create` |
| PATCH | `/catalog/categories/:id` | `categories.edit` |
| GET/POST | `/catalog/brands` | `brands.view` / `.create` |
| PATCH | `/catalog/brands/:id` | `brands.edit` |
| GET/POST | `/catalog/uoms` | `uoms.view` / `.create` |
| PATCH | `/catalog/uoms/:id` | `uoms.edit` |
| GET/POST | `/catalog/attributes` | `attributes.view` / `.create` |
| PATCH | `/catalog/attributes/:id` | `attributes.edit` |
| POST | `/catalog/attributes/:id/values` | `attributes.create` |
| PATCH/DELETE | `/catalog/attribute-values/:id` | `attributes.edit` / `.delete` |
| GET/POST | `/catalog/products` | `products.view` / `.create` |
| GET/PATCH | `/catalog/products/:id` | `products.view` / `.edit` |
| PUT | `/catalog/products/:id/bundle-items` | `products.edit` |
| POST | `/catalog/products/:id/variants` | `products.create` |
| POST | `/catalog/products/:id/uoms` | `products.edit` |
| DELETE | `/catalog/product-uoms/:id` | `products.edit` |
| GET | `/catalog/variants/lookup?barcode=\|sku=` | `products.view` |
| GET/PATCH | `/catalog/variants/:id` | `products.view` / `.edit` |
| PATCH | `/catalog/variants/:id/cost` | `products.change_cost` |
| PATCH | `/catalog/variants/:id/price` | `products.change_price` |
| POST | `/catalog/variants/:id/barcodes` | `products.edit` |
| DELETE | `/catalog/barcodes/:id` | `products.edit` |
| GET/POST | `/catalog/price-lists` | `pricelists.view` / `.create` |
| PATCH | `/catalog/price-lists/:id` | `pricelists.edit` |
| GET/PUT | `/catalog/price-lists/:id/prices` | `pricelists.view` / `.manage_prices` |
| GET | `/catalog/sync?updatedSince=&includeInactive=` | `products.view` |

All request bodies/queries validated against shared zod schemas in `packages/shared-validation/src/catalog.ts` — the same schemas the offline POS client will import directly from Phase 5 onward.

## Screens
None (still backend-only — see Pending Features).

## Tests and Results
- **Unit** (no DB): 6 new tests for the pure domain helpers `omitFields` (cost-stripping primitive) and `attributeSignature` (order-independent variant-combination fingerprint) — the rest of Phase 2's logic is inherently DB-bound (uniqueness, cross-table checks, transactions) and is covered by the e2e suite instead, same judgment call as Phase 1. Combined with Phase 1's unit tests: **17/17 pass.**

- **E2E** (real NestJS app + real PostgreSQL `erp_test`, no mocks): **46 new tests, 4 new files**, combined with Phase 1's 28: **74/74 pass.**
  - `catalog-reference-data.e2e-spec.ts` (12) — categories (tree creation, top-level duplicate name rejected via the partial unique index, same name allowed under different parents, self-parent and ancestor/descendant cycle rejected, 404 on a cross-tenant parentId), brands/UOMs (duplicate name/code rejected, precision range validated, code normalization), attributes/values (duplicate value rejected, deleting an unused value succeeds, deleting a value still attached to a variant is blocked).
  - `catalog-products.e2e-spec.ts` (21) — simple-product auto-default-variant, duplicate SKU/bad references/bad stock-range rejected; multi-variant products with distinct attribute combinations and per-variant barcodes/prices; duplicate attribute combination rejected both within one request and against a variant added afterward; a variant carrying two values for one attribute rejected; cross-table SKU collision (a new variant's SKU colliding with an existing Product's SKU) rejected; full bundle lifecycle (create, reject empty/non-bundle-with-items, reject nested bundles, replace composition, reject replacing on a non-bundle); add-variant/update-variant/change-cost/change-price (each price change verified to write a `ProductPriceHistory` row with the correct old/new values); barcode lookup by barcode and by SKU, 404 on unknown barcode, 422 when neither query param given, duplicate barcode rejected, primary-barcode swap; product-UOM add/reject-base-UOM/reject-duplicate/reject-non-positive-factor; search + pagination.
  - `catalog-price-lists.e2e-spec.ts` (4) — duplicate name rejected; only one default price list per tenant (creating a second default un-defaults the first, matching the Phase 1 default-warehouse pattern); upsert is a true update-in-place (not a duplicate row) and both changes land in price history; 404 when pricing a variant from another tenant.
  - `catalog-permissions-and-isolation.e2e-spec.ts` (9) — the highest-value suite: a Cashier (no `products.view_cost`) gets `cost`/`defaultCost` fields stripped from product list, product detail, and barcode/SKU lookup responses alike, while the Owner sees them; the same Cashier is blocked (403) from creating a product or changing cost/price even though they can view products; an Inventory Manager's default template grants confirmed to include `products.change_cost`; **tenant isolation proven at both layers again**, this time for the new tables — API layer (tenant B can't see/fetch/modify tenant A's products or variants, gets 404 not silent success), and independently at the PostgreSQL layer via raw SQL as the same restricted `erp_app` role with no application-level filter at all (unfiltered `SELECT * FROM products` returns zero rows with no tenant context set; setting context to A returns only A's rows; inserting a product for A while context is B is rejected by RLS `WITH CHECK`; `UPDATE`/`DELETE` on `product_price_history` and `DELETE` on `products`/`product_variants` fail with a Postgres permission-denied error regardless of RLS, because the grant was never given at all).

- No new "quiet transactional bug" class of issue surfaced this phase (Phase 1's login/audit rollback bug was the one that did); Phase 2's transactions were written with that lesson already applied (every use case returns from inside `withTenant` rather than throwing after a side effect it wants kept).

## Security Review
Everything from Phase 1 stands unchanged (argon2id, JWT access+refresh, RLS + restricted role, helmet/CORS, global rate limiting, audit trail, no secrets committed). Phase 2 additions:
- **New field-level authorization primitive** (`EffectivePermissionsService`, shared by `PermissionsGuard` and any use-case needing an in-request check) removes the duplicated permission-resolution query that existed only inside the guard before — one place computes "what can this user do right now," reused rather than reimplemented for the cost-visibility check.
- Verified (by test) that a caller without `products.view_cost` genuinely never receives `cost`/`defaultCost` in the HTTP response body at all — not merely a value the frontend is expected to hide.
- Same rate-limiting gap noted in Phase 1 (`/auth/login` shares the global throttle) still applies; Phase 2 introduced no new auth-adjacent surface.

## Business Logic Review
- SKU cross-table uniqueness, attribute-combination integrity (both the "two values for one attribute" and "two identical variants" cases), category cycle prevention, bundle composition rules (no empty bundles, no bundles-in-bundles, no self-reference, `SIMPLE` products can't carry bundle items), and the single-default invariants (price list, and the base-UOM-can't-also-be-a-ProductUom rule) are all real, DB-transaction-backed checks — not client-side hints — and each has a failing-case test.
- Every price/cost change writes an immutable history row in the same transaction as the change itself (matches the Phase 1 "audit alongside the mutation, same transaction, both commit or both roll back" pattern).
- No feature computes a derived value (a total, an available quantity, a valuation) from a denormalized "current price" field without going through the actual variant/history record — there is no such derived computation in Phase 2 yet; this stays a forward-looking invariant for Phase 3's costing engine.

## Known Issues / Technical Debt
Phase 1's list stands unchanged (no frontend yet — flagged again below since it's now two phases overdue for a decision; no dedicated login rate limit; no refresh-token-reuse defensive cascade; `erp_app` dev-default password; no invite/reset/2FA; Redis/BullMQ unused). New from Phase 2:

7. **No hard-delete endpoint for Category/Brand/UOM/PriceList.** Soft `isActive` covers the practical need for Phase 2; a genuine "permanently remove a never-used category" admin action can be added later without a schema change (the DB grants already allow it).
8. **`Product.defaultCost`/`defaultSellingPrice` cannot be edited after creation via the API** (by design — see Architecture Decisions). If a future phase decides simple products need a "just change the one price" shortcut distinct from `PATCH /catalog/variants/:id/price`, that's an additive UX convenience, not a data-model change.
9. **Bundle components are validated to be non-bundle products, but there's no limit on bundle depth beyond that one level** (a bundle can't contain a bundle, full stop, rather than a depth check) — simpler and sufficient for Phase 2; revisit only if a real multi-level bundle need appears.
10. **No image upload endpoint** — `images` is a caller-supplied JSON array of URLs (validated as real URLs), not a file upload. Real asset storage is unscoped infrastructure work, not part of any phase's plan yet.
11. **`ProductAttribute`/`ProductAttributeValue` don't carry `createdBy`/`updatedBy`** the way every other Phase 1/2 entity does (a minor inconsistency, not a functional gap — audit trail for these still exists via `AuditLog`).

## Files Created
Prisma migrations: `apps/api/prisma/migrations/20260828124217_catalog_schema/`, `.../20260828124500_catalog_rls/`, `.../20260828124600_catalog_app_role_grants/`.

Shared packages: `packages/shared-validation/src/primitives.ts`, `packages/shared-validation/src/catalog.ts`.

API — authorization: `apps/api/src/common/authorization/effective-permissions.service.ts`, `.../authorization.module.ts`.

API — catalog module (`apps/api/src/modules/catalog/`): `catalog.module.ts`; `domain/{includes,omit-fields,sku-guard,attribute-values}.ts` + `domain/__tests__/{omit-fields,attribute-values}.spec.ts`; `application/{categories,brands,uoms,attributes,products,variants,product-uoms,barcodes,price-lists,catalog-sync}.service.ts`; `presentation/{categories,brands,uoms,attributes,products,variants,price-lists,catalog-sync,catalog-admin}.controller.ts`.

Tests: `apps/api/test/catalog-{reference-data,products,price-lists,permissions-and-isolation}.e2e-spec.ts`, `apps/api/test/utils/register-and-login.ts`.

## Files Modified
`apps/api/prisma/schema.prisma` (14 new models/4 enums + Business relations), `apps/api/prisma/seed.ts` (permission descriptions + owner-role backfill), `apps/api/src/app.module.ts` (wire `AuthorizationModule`/`CatalogModule`), `apps/api/src/common/guards/permissions.guard.ts` (refactored to use `EffectivePermissionsService`), `apps/api/test/db-reset.ts` (truncate the 14 new tables too), `packages/shared-types/src/permissions.ts` (27 new codes + role-template grants), `packages/shared-validation/src/index.ts` (re-exports `primitives.ts`/`catalog.ts`).

## Next Phase
**Phase 3 — Inventory Engine**: Stock Ledger, Stock Balance, Opening Stock, Adjustments, Stock Count, Transfers, Lots, Expiry, Serial numbers.
**Will not start until you explicitly approve this Phase 2 report.**
