# OrderPRO

Independent OMS/WMS and operational inventory platform for Modern State. The existing storefront and Square remain external systems.

## Safety status

This repository is in foundation construction. Production operations and all Square writes are disabled. Do not expose it to operational users yet.

## Stack

- Next.js 16 App Router, React 19 and TypeScript
- PostgreSQL and Prisma
- Zod validation and Vitest

## Verify

```bash
npm run check
DATABASE_URL=postgresql://orderpro:orderpro@localhost:5432/orderpro npm run prisma:validate
DATABASE_URL=postgresql://orderpro:orderpro@localhost:5432/orderpro npm run prisma:generate
npm run build
```
