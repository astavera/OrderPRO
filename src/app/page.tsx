import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/application/auth/current-principal";

export default async function Home() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  redirect(principal.account ? "/operations" : "/access-pending");
}
