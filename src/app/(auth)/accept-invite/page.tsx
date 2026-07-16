import Link from "next/link";
import { AcceptInviteForm } from "./accept-invite-form";

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const parameters = await searchParams;
  const tokenHash = typeof parameters.token_hash === "string" ? parameters.token_hash : null;
  const valid = tokenHash && parameters.type === "invite";

  return <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-slate-100"><section className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-8"><p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">Modern State operations</p><h1 className="mt-3 text-3xl font-semibold">Accept your invitation</h1><p className="mt-3 text-slate-400">Continue to verify the one-time invitation before choosing your password.</p>{valid ? <AcceptInviteForm tokenHash={tokenHash} /> : <div className="mt-6"><p className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">This invitation link is incomplete or invalid.</p><Link className="mt-5 inline-block text-sm text-emerald-300" href="/login">Return to sign in</Link></div>}</section></main>;
}
