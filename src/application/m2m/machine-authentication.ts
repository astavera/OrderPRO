import type { MachineClientPrincipal } from "./machine-client-registry";

// The principal uses OrderPro's stable internal client key and the effective
// token/registry scope intersection. It never exposes an Auth0 Client ID.
export type MachinePrincipal = MachineClientPrincipal;

export type MachineAuthenticationResult =
  | {
      readonly authenticated: true;
      readonly principal: MachinePrincipal;
    }
  | {
      readonly authenticated: false;
      readonly code: "UNAUTHORIZED" | "M2M_AUTH_NOT_CONFIGURED";
    };

export type MachineAuthenticator = (
  request: Request,
) => Promise<MachineAuthenticationResult>;
