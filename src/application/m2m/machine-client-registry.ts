export type MachineEnvironment = "STAGING" | "PRODUCTION";

export type MachineClientPrincipal = {
  readonly clientId: string;
  readonly environment: MachineEnvironment;
  readonly scopes: readonly string[];
};

export type ResolveMachineClientInput = {
  readonly provider: "AUTH0";
  readonly issuer: string;
  readonly externalClientId: string;
  readonly environment: MachineEnvironment;
  readonly tokenScopes: readonly string[];
};

export type ResolveMachineClientResult =
  | {
      readonly resolved: true;
      readonly principal: MachineClientPrincipal;
    }
  | {
      readonly resolved: false;
      readonly reason: "NOT_AUTHORIZED" | "UNAVAILABLE";
    };

export interface MachineClientRegistry {
  resolve(input: ResolveMachineClientInput): Promise<ResolveMachineClientResult>;
}
