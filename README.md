# OrderPRO

Independent OMS/WMS and operational inventory platform for Modern State. The existing storefront and Square remain external systems.

## Safety status

This repository is in foundation construction. Production operations, walking-zone publication, storefront availability and all Square writes are disabled. The fulfillment screens are an internal draft control plane, not a production quote source.

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

Authentication, invitation acceptance, user administration, location-scoped authorization and the first idempotent box-creation command are implemented. Boxes now have scanner-ready lookup and a read-only detail view covering locations, manifest, projected contents, ledger and seals. Inventory content and movement mutations remain locked while the product catalog, transactional services and integration tests are built.

The fulfillment foundation now also separates two operational paths: walking delivery goes directly from the selected store to the customer, while carrier shipping backed by store inventory is reserved at the store, retrieved through the Englewood warehouse and adds two business days to the warehouse-carrier promise. The internal `/operations/fulfillment` control plane includes five walking-zone drafts, deterministic geometry validation and evaluation, location-scoped draft editing, and incomplete store-to-warehouse policy shells. Saving a draft never publishes it. See [Fulfillment and walking delivery](docs/fulfillment-walking-delivery.md) and [E-commerce integration readiness](docs/ecommerce-walking-integration.md).

The DRAFT/STAGING Local Walking Delivery V4 contract adds the ten-tier route-distance policy, explicit geographic `eligible` versus current `bookable` status, `Contact store` for valid Manhattan addresses outside the five supported ZIPs, and atomic capacity/inventory hold endpoints. Read-only policy, quote and hold Prisma adapters plus a conservative inventory-allocation strategy now exist, but remain disconnected. The Auth0 RFC 9068 verifier and durable M2M registry are implemented, while the client/grants remain pending. The HTTP runtime is deliberately unable to become ready until end-to-end token evidence, audited client activation, every real provider/store and a certified composition root are complete. See the [V4 specification](docs/local-walking-delivery-v4.md), [OpenAPI contract](docs/openapi/orderpro-local-delivery-v1.yaml), and [change report](docs/reports/local-walking-delivery-v4-change-report.md).

See [Supabase Database](docs/supabase.md) for connection modes, RLS hardening, migrations and environment separation.

Health endpoints:

- `/api/health`: process liveness and safety state.
- `/api/health/ready`: uncached readiness for Supabase PostgreSQL and Auth. It returns only stable public dependency codes.
