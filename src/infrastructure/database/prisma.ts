import "server-only";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { orderProPrisma?: PrismaClient };

export const prisma = globalForPrisma.orderProPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.orderProPrisma = prisma;
