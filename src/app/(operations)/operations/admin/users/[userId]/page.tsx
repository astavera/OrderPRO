import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getManagedUserEditData } from "@/application/admin/user-management";
import { UserAccessForm } from "../user-access-form";

export const dynamic = "force-dynamic";

export default async function EditUserPage({ params }: PageProps<"/operations/admin/users/[userId]">) {
  const { userId } = await params;
  if (!z.string().uuid().safeParse(userId).success) notFound();
  const data = await getManagedUserEditData(userId);
  if (!data) notFound();

  return <section><Link className="text-sm text-emerald-300 hover:text-emerald-200" href="/operations/admin/users">← Users & access</Link><p className="mt-6 text-sm font-semibold uppercase tracking-[0.18em] text-emerald-400">Administration</p><h1 className="mt-2 text-4xl font-semibold">Edit {data.user.displayName}</h1><p className="mt-3 text-slate-400">Changes are versioned and written to the append-only access audit.</p><div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-5"><UserAccessForm isSelf={data.actorId === data.user.id} locations={data.locations} roles={data.roles} user={data.user} /></div></section>;
}
