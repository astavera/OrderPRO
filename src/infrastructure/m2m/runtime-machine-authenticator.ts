import "server-only";

import type { MachineAuthenticator } from "@/application/m2m/machine-authentication";
import { getAuth0M2mConfiguration } from "./auth0-config";
import { createAuth0MachineAuthenticator } from "./auth0-machine-authenticator";
import { PrismaMachineClientRegistry } from "./prisma-machine-client-registry";

const unavailable: MachineAuthenticator = async () => ({
  authenticated: false,
  code: "M2M_AUTH_NOT_CONFIGURED",
});

function composeRuntimeMachineAuthenticator(): MachineAuthenticator {
  const configuration = getAuth0M2mConfiguration();
  if (!configuration.valid) return unavailable;

  return createAuth0MachineAuthenticator({
    config: configuration.config,
    registry: new PrismaMachineClientRegistry(),
  });
}

export const runtimeMachineAuthenticator = composeRuntimeMachineAuthenticator();
