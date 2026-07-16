# Supabase Database

OrderPRO uses Supabase-managed PostgreSQL as its only durable database. It does not use an embedded or production-local database.

## Connections

como debo de poner `: Supavisor transaction pooler on port 6543 for Next.js/serverless runtime. The URL includes `pgbouncer=true` to disable prepared statements and a conservative connection limit.
- `DIRECT_URL`: Supavisor session-mode endpoint on port 5432 for Prisma migrations. This project uses it because it is IPv4-compatible.

The configured project reference is `vzuibvzwodrhryphkqjz` in `us-east-2`. Copy the database password from the Supabase project **Connect** dialog and replace `[YOUR-PASSWORD]` only in ignored `.env.local` or deployment secrets. Never commit the real password.

## Security model

The browser never receives database credentials. OrderPRO uses Prisma only from server modules. The initial migration enables RLS on every operational table without public policies and revokes table/sequence access from Supabase `anon` and `authenticated` roles when present. Do not add browser Data API policies without a separate threat-model review.

Supabase Auth uses `NEXT_PUBLIC_SUPABASE_URL` and the publishable key from the same project. The key is public by design, but it must never be replaced with a secret or `service_role` key. `/api/health/ready` verifies both PostgreSQL and Auth without returning provider messages or credentials.

## Auth administration and invitations

Administrative invitations require `SUPABASE_SECRET_KEY` (`sb_secret_...`) and `ORDERPRO_APP_URL`. The secret key is server-only, bypasses Data API RLS and must never use a `NEXT_PUBLIC_` prefix. The legacy `SUPABASE_SERVICE_ROLE_KEY` is accepted temporarily for migration, but new environments should use the current secret key.

Add the application routes to **Authentication → URL Configuration → Redirect URLs** in Supabase. Local development requires `http://localhost:3001/**`; production should use the exact HTTPS application origin.

Customize the Supabase **Invite user** email template so link scanners cannot consume the one-time token on a GET request. Point the template at the OrderPRO confirmation page and pass the token hash:

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite">Accept the OrderPRO invitation</a>
```

OrderPRO renders that link without verifying it, then consumes the token only after the user presses **Accept invitation**. The resulting session can set a password at `/set-password`; the session is signed out afterward so the user performs a normal password login.

Roles and location grants are never read from Supabase `user_metadata`. They remain in PostgreSQL because user metadata can be edited by the authenticated user and is not an authorization boundary.

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
