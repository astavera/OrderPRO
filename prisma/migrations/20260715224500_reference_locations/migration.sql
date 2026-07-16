-- Canonical operational locations. Square mappings remain intentionally empty
-- until a read-only audit confirms the real Square location IDs.
INSERT INTO "OperationalLocation" (id, code, name, type, active, "createdAt", "updatedAt")
VALUES
  ('00000000-0000-4000-8000-000000000072', 'ST72', 'Store 72', 'STORE', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000000086', 'ST86', 'Store 86', 'STORE', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000000101', 'WH01', 'Warehouse', 'WAREHOUSE', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  active = EXCLUDED.active,
  "updatedAt" = CURRENT_TIMESTAMP;

-- Every operational capability starts disabled and requires an explicit,
-- audited production-readiness decision before activation.
INSERT INTO "FeatureFlag" (key, enabled, description, rules, "updatedAt")
VALUES
  ('inventory.mutations', false, 'Allows authenticated OrderPRO inventory mutation commands.', NULL, CURRENT_TIMESTAMP),
  ('storefront.availability', false, 'Allows OrderPRO availability to influence the storefront.', NULL, CURRENT_TIMESTAMP),
  ('square.production_writes', false, 'Allows production Square mutation workers.', NULL, CURRENT_TIMESTAMP),
  ('warehouse.box_workflow', false, 'Exposes the store-to-WH01 box workflow to operational users.', NULL, CURRENT_TIMESTAMP)
ON CONFLICT (key) DO NOTHING;
