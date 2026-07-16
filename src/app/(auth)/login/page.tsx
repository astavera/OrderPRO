import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/application/auth/current-principal";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const principal = await getCurrentPrincipal();
  if (principal?.account) redirect("/operations");
  return <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-slate-100"><section className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-8"><p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">Modern State operations</p><h1 className="mt-3 text-4xl font-semibold">OrderPRO</h1><p className="mt-3 text-slate-400">Authorized team members only.</p><LoginForm /></section></main>;
}
