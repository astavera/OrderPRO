import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/infrastructure/supabase/server";
import { SetPasswordForm } from "./set-password-form";

export default async function SetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  if (!data.user) redirect("/login?invite=expired");

  return <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-slate-100"><section className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-8"><p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">Modern State operations</p><h1 className="mt-3 text-3xl font-semibold">Choose your password</h1><p className="mt-3 text-slate-400">Use at least 8 characters. You will sign in again after saving it.</p><SetPasswordForm /></section></main>;
}
