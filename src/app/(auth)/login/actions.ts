"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/infrastructure/supabase/server";

export type LoginState = { error?: string };
const schema = z.object({ email: z.string().email(), password: z.string().min(8).max(128) });

export async function login(_state: LoginState, formData: FormData): Promise<LoginState> {
  const input = schema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!input.success) return { error: "Enter a valid email and password." };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "Authentication is not configured yet." };
  const { error } = await supabase.auth.signInWithPassword(input.data);
  if (error) return { error: "Invalid credentials or access is not enabled." };
  redirect("/operations");
}

export async function logout() {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut();
  redirect("/login");
}
