"use server";

import { redirect } from "next/navigation";
import { requirePermission } from "@/application/auth/current-principal";
import { isValidBoxCode, normalizeBoxCode } from "@/domain/inventory/box-code";

export async function openBoxAction(formData: FormData) {
  await requirePermission("boxes.view");
  const code = normalizeBoxCode(String(formData.get("q") ?? "")).slice(0, 16);
  if (!code) redirect("/operations/boxes");
  if (isValidBoxCode(code)) redirect(`/operations/boxes/${code}`);
  redirect(`/operations/boxes?q=${encodeURIComponent(code)}`);
}
