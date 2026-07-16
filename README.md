# OrderPRO

Independent OMS/WMS and operational inventory platform for Modern State. The existing storefront and Square remain external systems.

## Safety status

This repository is in foundation construction. Production operations and all Square writes are disabled. Do not expose it to operational users yet.

## Stack

- Next.js 16 App Router, React 19 and TypeScript
- Supabase-managed PostgreSQL and Prisma
- Zod validation and Vitest

## Verify

```bash
npm run check
DATABASE_URL="$SUPABASE_POOLER_URL" DIRECT_URL="$SUPABASE_DIRECT_URL" npm run prisma:validate
DATABASE_URL="$SUPABASE_POOLER_URL" DIRECT_URL="$SUPABASE_DIRECT_URL" npm run prisma:generate
npm run build
```

## Current implementation

The repository now contains the permanent initial schema for locations, location-scoped RBAC, audit, idempotency, inbox/outbox, owner lots, containers, versioned manifests, seals and an append-only inventory ledger. See [Inventory Foundation](docs/inventory-foundation.md).

Database-backed write APIs remain intentionally unavailable until authentication, authorization, transaction services and integration tests are implemented.

See [Supabase Database](docs/supabase.md) for connection modes, RLS hardening, migrations and environment separation.

Health endpoints:

- `/api/health`: process liveness and safety state.
- `/api/health/ready`: uncached Supabase connectivity readiness.
