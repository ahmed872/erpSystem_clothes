-- Row-Level Security for Phase 2 (Products & Catalog) tables, following
-- the exact same pattern established in migration
-- 20260828121500_enable_row_level_security: default-deny, scoped to
-- current_setting('app.current_tenant_id', true).

-- Direct business_id column: straightforward policy.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'categories', 'brands', 'uoms', 'product_attributes', 'product_attribute_values',
    'products', 'product_variants', 'product_uoms', 'barcodes',
    'price_lists', 'product_prices', 'product_price_history'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (business_id = current_setting(''app.current_tenant_id'', true)) WITH CHECK (business_id = current_setting(''app.current_tenant_id'', true))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END
$$;

-- Pure join tables without their own business_id: scoped transitively via
-- their parent row's tenant, same pattern as user_roles/user_branches/
-- role_permissions in migration 20260828121500_enable_row_level_security.

ALTER TABLE "variant_attribute_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "variant_attribute_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY variant_attribute_values_tenant_isolation ON "variant_attribute_values"
  USING (
    EXISTS (
      SELECT 1 FROM "product_variants" v
      WHERE v.id = "variant_attribute_values".variant_id
        AND v.business_id = current_setting('app.current_tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "product_variants" v
      WHERE v.id = "variant_attribute_values".variant_id
        AND v.business_id = current_setting('app.current_tenant_id', true)
    )
  );

ALTER TABLE "bundle_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bundle_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY bundle_items_tenant_isolation ON "bundle_items"
  USING (
    EXISTS (
      SELECT 1 FROM "products" p
      WHERE p.id = "bundle_items".bundle_product_id
        AND p.business_id = current_setting('app.current_tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "products" p
      WHERE p.id = "bundle_items".bundle_product_id
        AND p.business_id = current_setting('app.current_tenant_id', true)
    )
    AND EXISTS (
      SELECT 1 FROM "product_variants" v
      WHERE v.id = "bundle_items".component_variant_id
        AND v.business_id = current_setting('app.current_tenant_id', true)
    )
  );
