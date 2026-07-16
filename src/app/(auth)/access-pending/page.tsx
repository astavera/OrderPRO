import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/application/auth/current-principal";
import { logout } from "../login/actions";

export default async function AccessPendingPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  if (principal.account) redirect("/operations");
  const disabled = principal.accessStatus === "DISABLED";

  return <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-slate-100"><section className="max-w-lg rounded-3xl border border-amber-400/30 bg-slate-900 p-8"><p className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">{disabled ? "Access disabled" : "Access pending"}</p><h1 className="mt-3 text-3xl font-semibold">{disabled ? "Your OrderPRO access is disabled." : "Your identity is verified."}</h1><p className="mt-4 text-slate-400">{disabled ? "Contact an OrderPRO administrator if you believe access should be restored." : "An OrderPRO administrator must assign a role and at least one operational location before you can continue."}</p><form action={logout}><button className="mt-6 rounded-xl border border-slate-700 px-4 py-2" type="submit">Sign out</button></form></section></main>;
}
