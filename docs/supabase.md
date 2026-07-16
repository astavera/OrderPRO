# Supabase Database

OrderPRO uses Supabase-managed PostgreSQL as its only durable database. It does not use an embedded or production-local database.

## Connections

como debo de poner `: Supavisor transaction pooler on port 6543 for Next.js/serverless runtime. The URL includes `pgbouncer=true` to disable prepared statements and a conservative connection limit.
- `DIRECT_URL`: Supavisor session-mode endpoint on port 5432 for Prisma migrations. This project uses it because it is IPv4-compatible.

The configured project reference is `vzuibvzwodrhryphkqjz` in `us-east-2`. Copy the database password from the Supabase project **Connect** dialog and replace `[YOUR-PASSWORD]` only in ignored `.env.local` or deployment secrets. Never commit the real password.

## Security model

The browser never receives database credentials. OrderPRO uses Prisma only from server modules. The initial migration enables RLS on every operational table without public policies and revokes table/sequence access from Supabase `anon` and `authenticated` roles when present. Do not add browser Data API policies without a separate threat-model review.

## Migration workflow

1. Create an isolated Supabase project for development/staging.
2. Set `DATABASE_URL` and `DIRECT_URL` in the deployment secret manager.
3. Run `npm run prisma:validate` and `npm run prisma:generate`.
4. Review the SQL in `prisma/migrations`.
5. Run `npm run prisma:migrate:deploy` using `DIRECT_URL`.
6. Verify constraints, RLS, triggers and reconciliation queries.

The liveness endpoint is `/api/health`. The readiness endpoint `/api/health/ready` executes a minimal server-only database probe and returns HTTP 503 when Supabase is unavailable. It never returns provider error details.

Production schema changes are migration-only. Do not edit operational tables through Supabase Table Editor or SQL Editor. Use separate Supabase projects or branches for preview/staging and production.

Backups are a shared responsibility: enable the plan appropriate for required RPO/RTO, verify PITR availability, and perform scheduled isolated restores. Provider backup status alone is not restore evidence.
