"use server";

import { redirect } from "next/navigation";
import {
  authenticationFailureMessage,
  classifyAuthenticationError,
  parseLoginCredentials,
  type AuthenticationFailure,
} from "@/application/auth/password-login";
import { createSupabaseServerClient } from "@/infrastructure/supabase/server";

export type LoginState = { error?: string; code?: AuthenticationFailure | "INVALID_INPUT" };

export async function login(_state: LoginState, formData: FormData): Promise<LoginState> {
  const input = parseLoginCredentials({ email: formData.get("email"), password: formData.get("password") });
  if (!input.success) return { code: "INVALID_INPUT", error: "Enter a valid email and password." };

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { code: "CONFIGURATION_ERROR", error: authenticationFailureMessage("CONFIGURATION_ERROR") };
  }

  try {
    const { error } = await supabase.auth.signInWithPassword(input.credentials);
    if (error) {
      const failure = classifyAuthenticationError(error);
      return { code: failure, error: authenticationFailureMessage(failure) };
    }
  } catch {
    return { code: "SERVICE_UNAVAILABLE", error: authenticationFailureMessage("SERVICE_UNAVAILABLE") };
  }

  redirect("/operations");
}

export async function logout() {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut();
  redirect("/login");
}
