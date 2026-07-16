"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/infrastructure/supabase/server";

export type AcceptInviteState = { error?: string };
const schema = z.object({ tokenHash: z.string().min(20).max(512), type: z.literal("invite") });

export async function acceptInvite(_state: AcceptInviteState, formData: FormData): Promise<AcceptInviteState> {
  const input = schema.safeParse({ tokenHash: formData.get("tokenHash"), type: formData.get("type") });
  if (!input.success) return { error: "This invitation link is invalid." };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "Authentication is not configured." };
  const { error } = await supabase.auth.verifyOtp({ token_hash: input.data.tokenHash, type: "invite" });
  if (error) return { error: "This invitation is invalid or has expired. Ask an administrator for a new invitation." };

  redirect("/set-password");
}
