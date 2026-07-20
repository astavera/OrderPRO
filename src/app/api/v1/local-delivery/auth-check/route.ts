import { createMachineAuthCheckPostHandler } from "@/application/m2m/machine-auth-check";
import { runtimeMachineAuthenticator } from "@/infrastructure/m2m/runtime-machine-authenticator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = createMachineAuthCheckPostHandler({
  authenticate: runtimeMachineAuthenticator,
});
