import { permissionCodes, permissionLabels, permissionsByRole, roleLabels } from "@/application/auth/permissions";
import type { RoleCode } from "@prisma/client";

export function RolePermissionMatrix({ roles }: { roles: RoleCode[] }) {
  return <div className="overflow-x-auto rounded-2xl border border-slate-800"><table className="w-full min-w-[900px] text-left text-sm"><caption className="sr-only">Permissions granted by each OrderPRO role</caption><thead className="bg-slate-900 text-slate-400"><tr><th className="px-4 py-3" scope="col">Permission</th>{roles.map((role) => <th className="px-4 py-3" key={role} scope="col">{roleLabels[role]}</th>)}</tr></thead><tbody>{permissionCodes.map((permission) => <tr className="border-t border-slate-800" key={permission}><th className="px-4 py-3 font-medium" scope="row">{permissionLabels[permission]}</th>{roles.map((role) => { const allowed = permissionsByRole[role].includes(permission); return <td className={allowed ? "px-4 py-3 text-emerald-300" : "px-4 py-3 text-slate-600"} key={role}>{allowed ? "Allowed" : "Not allowed"}</td>; })}</tr>)}</tbody></table></div>;
}
