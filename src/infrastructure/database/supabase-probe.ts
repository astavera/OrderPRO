import "server-only";
import { Prisma } from "@prisma/client";
import type { DatabaseProbe } from "@/application/health/check-database-readiness";
import { prisma } from "./prisma";

export const supabaseDatabaseProbe: DatabaseProbe = {
  async execute() {
    await prisma.$queryRaw(Prisma.sql`SELECT 1`);
  },
};
