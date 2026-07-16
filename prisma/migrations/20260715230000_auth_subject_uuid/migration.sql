-- Supabase Auth user IDs are UUID primary keys. OrderPRO stores the stable auth
-- subject, never an email address, as the identity join key.
ALTER TABLE "User"
ALTER COLUMN "subject" TYPE uuid USING "subject"::uuid;
