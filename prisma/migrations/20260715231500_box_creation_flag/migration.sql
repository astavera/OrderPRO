INSERT INTO "FeatureFlag" (key, enabled, description, rules, "updatedAt")
VALUES ('warehouse.box_creation', true, 'Allows authorized users to create empty OPEN boxes.', NULL, CURRENT_TIMESTAMP)
ON CONFLICT (key) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  description = EXCLUDED.description,
  "updatedAt" = CURRENT_TIMESTAMP;
