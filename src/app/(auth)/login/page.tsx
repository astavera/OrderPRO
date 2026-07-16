import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/application/auth/current-principal";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const parameters = await searchParams;
  const principal = await getCurrentPrincipal();
  if (principal) redirect(principal.account ? "/operations" : "/access-pending");
  const notice = parameters.password === "updated"
    ? "Your password is ready. Sign in to continue."
    : parameters.invite === "expired"
      ? "Your invitation session expired. Ask an administrator for a new invitation."
      : null;
  return <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-slate-100"><section className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-8"><p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">Modern State operations</p><h1 className="mt-3 text-4xl font-semibold">OrderPRO</h1><p className="mt-3 text-slate-400">Authorized team members only.</p>{notice ? <p className="mt-5 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-200" role="status">{notice}</p> : null}<LoginForm /></section></main>;
}
