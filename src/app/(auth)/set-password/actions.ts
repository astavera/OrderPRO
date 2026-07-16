"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/infrastructure/supabase/server";

export type SetPasswordState = { error?: string };
const schema = z.object({
  password: z.string().min(8).max(128),
  confirmPassword: z.string(),
}).refine(({ password, confirmPassword }) => password === confirmPassword, { path: ["confirmPassword"] });

export async function setInvitedUserPassword(_state: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
  const input = schema.safeParse({ password: formData.get("password"), confirmPassword: formData.get("confirmPassword") });
  if (!input.success) return { error: "Use at least 8 characters and enter the same password twice." };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "Authentication is not configured." };
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: "Your invitation session expired. Ask an administrator for a new invitation." };

  const { error } = await supabase.auth.updateUser({ password: input.data.password });
  if (error) {
    return { error: error.code === "weak_password" ? "That password does not meet the security policy." : "The password could not be saved. Try again." };
  }
  await supabase.auth.signOut();
  redirect("/login?password=updated");
}
